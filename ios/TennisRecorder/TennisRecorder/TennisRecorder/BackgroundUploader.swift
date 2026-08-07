import Foundation

/// Persisted plan for one in-flight multipart upload, so it survives the app
/// being suspended, relaunched, or terminated by the system.
private struct UploadJob: Codable {
    let recordingId: UUID
    let videoId: String
    let durationS: Double
    let size: Int
    var parts: [Part]

    struct Part: Codable {
        let number: Int
        let file: String // part temp-file name within the job dir
        let size: Int
        var etag: String?
    }

    var uploadedBytes: Int { parts.filter { $0.etag != nil }.reduce(0) { $0 + $1.size } }
    var allUploaded: Bool { parts.allSatisfy { $0.etag != nil } }
}

/// Uploads recordings via a background `URLSession`, so transfers continue while
/// the app is suspended or the screen is off. Every part of the multipart upload
/// is enqueued up front as its own background upload task; the system finishes
/// them while we're away, ETags are collected as tasks complete (even across a
/// relaunch), then the upload is completed on the server.
final class BackgroundUploader: NSObject {
    static let shared = BackgroundUploader()
    private static let sessionID = "com.tobykeating.TennisRecorder.bgupload"

    /// Set by the app delegate when iOS relaunches us to finish background events.
    var backgroundCompletion: (() -> Void)?

    private let api = UploadAPI()
    private let work = DispatchQueue(label: "BackgroundUploader.jobs")
    private let jobsDir: URL

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
        cfg.sessionSendsLaunchEvents = true
        cfg.isDiscretionary = false
        cfg.allowsCellularAccess = true
        cfg.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    private override init() {
        jobsDir = RecordingStore.documentsURL.appendingPathComponent("uploads", isDirectory: true)
        super.init()
        try? FileManager.default.createDirectory(at: jobsDir, withIntermediateDirectories: true)
    }

    /// Whether a recording still has an active background upload job on disk.
    func hasActiveJob(_ id: UUID) -> Bool {
        FileManager.default.fileExists(atPath: jobURL(id).path)
    }

    /// Reconnect the background session (so its delegate is wired after a launch)
    /// and finalize any jobs whose parts all finished while we were away.
    func resume() {
        _ = session
        work.async { self.finalizeCompletedJobs() }
        // Finish freeing local storage for anything uploaded but not yet reclaimed
        // (e.g. the app was killed between completing and verifying).
        Task { await self.reconcileUploaded() }
    }

    /// For recordings already uploaded but still holding a local video file, confirm
    /// the cloud copy and free the local file. Idempotent; skips already-freed items.
    private func reconcileUploaded() async {
        for rec in RecordingStore.load() where rec.status == .uploaded && !rec.fileName.isEmpty {
            guard let videoId = rec.remoteVideoId else { continue }
            await freeLocalIfConfirmed(recordingId: rec.id, videoId: videoId)
        }
    }

    /// Delete a recording's local video file to free space — but ONLY after the
    /// server confirms it holds a good copy (video finished + thumbnail uploaded).
    /// Never deletes on any doubt; the small poster thumbnail is kept locally so the
    /// row still renders instantly. This is the only automatic deletion in the app.
    private func freeLocalIfConfirmed(recordingId: UUID, videoId: String) async {
        // 1. Make sure the poster thumbnail is in the cloud (re-upload is idempotent).
        //    If we have a local thumbnail, require the upload to succeed before freeing.
        if let jpeg = try? Data(contentsOf: Thumbnailer.diskURL(for: recordingId)) {
            guard (try? await api.uploadThumbnail(videoId: videoId, jpeg: jpeg)) != nil else { return }
        }
        // 2. Re-fetch the video and confirm the server actually has the finished copy.
        guard let detail = try? await api.getVideo(videoId: videoId) else { return }
        guard detail.video.status == "ready" || detail.video.status == "processing" else { return }

        // 3. Only now remove the local video file, and mark the entry cloud-only.
        let recordings = RecordingStore.load()
        guard let rec = recordings.first(where: { $0.id == recordingId }), !rec.fileName.isEmpty else { return }
        try? FileManager.default.removeItem(at: RecordingStore.documentsURL.appendingPathComponent(rec.fileName))
        RecordingStore.update(id: recordingId) { $0.fileName = "" }
    }

    // MARK: - Start an upload

    func start(recording: Recording, fileURL: URL) {
        RecordingStore.update(id: recording.id) { $0.status = .uploading; $0.progress = 0; $0.uploadError = nil }
        Task.detached { [self] in
            do {
                try await prepareAndEnqueue(recording: recording, fileURL: fileURL)
            } catch {
                RecordingStore.update(id: recording.id) { $0.status = .failed; $0.uploadError = "Couldn't start upload: \(error.localizedDescription)" }
            }
        }
    }

    private func prepareAndEnqueue(recording: Recording, fileURL: URL) async throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? Int) ?? 0

        // Generate the poster thumbnail now, while the video file is still on disk,
        // so it's ready to upload once the video completes (and survives even if the
        // local video is later removed to free space).
        _ = await Thumbnailer.thumbnail(for: recording.id, videoURL: fileURL)

        let start = try await api.initiate(title: recording.title, contentType: "video/quicktime",
                                           sizeBytes: size, participants: recording.participants ?? [])
        let partSize = start.partSizeBytes
        let partCount = max(1, Int(ceil(Double(size) / Double(partSize))))

        let dir = jobDir(recording.id)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Split into part files on disk (background uploads need a file per task)
        // and fetch a presigned URL for each part. Keep the URL objects as-is —
        // do NOT round-trip through a string, which can corrupt S3's signature.
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var parts: [UploadJob.Part] = []
        var urls: [Int: URL] = [:]
        for number in 1...partCount {
            try handle.seek(toOffset: UInt64((number - 1) * partSize))
            let chunk = try handle.read(upToCount: partSize) ?? Data()
            let name = "part-\(number)"
            try chunk.write(to: dir.appendingPathComponent(name), options: .atomic)
            let resp = try await api.partURL(videoId: start.videoId, partNumber: number)
            urls[number] = api.absolutePartURL(resp.url)
            parts.append(.init(number: number, file: name, size: chunk.count, etag: nil))
        }

        // Persist the job BEFORE enqueuing, so a fast part can't complete and find
        // no job to record its ETag against.
        let job = UploadJob(recordingId: recording.id, videoId: start.videoId,
                            durationS: recording.durationS, size: size, parts: parts)
        work.sync { saveJob(job) }

        for part in parts {
            guard let url = urls[part.number] else { continue }
            var req = URLRequest(url: url)
            req.httpMethod = "PUT"
            let task = session.uploadTask(with: req, fromFile: dir.appendingPathComponent(part.file))
            task.taskDescription = "\(recording.id.uuidString)|\(part.number)"
            task.resume()
        }
    }

    /// Cancel and clean up a recording's upload (e.g. when it's deleted).
    func cancel(_ id: UUID) {
        cancelTasks(for: id)
        work.async { self.removeJob(id) }
    }

    private func cancelTasks(for id: UUID) {
        session.getAllTasks { tasks in
            for t in tasks where t.taskDescription?.hasPrefix(id.uuidString + "|") == true { t.cancel() }
        }
    }

    private func fail(_ id: UUID, _ message: String) {
        cancelTasks(for: id)
        RecordingStore.update(id: id) {
            guard $0.status == .uploading else { return } // keep the first failure's reason
            $0.status = .failed
            $0.uploadError = message
        }
    }

    // MARK: - Completion

    private func finalizeCompletedJobs() {
        for job in allJobs() where job.allUploaded { complete(job) }
    }

    private func complete(_ job: UploadJob) {
        let uploaded = job.parts.compactMap { p -> UploadedPart? in
            guard let etag = p.etag else { return nil }
            return UploadedPart(partNumber: p.number, etag: etag, size: p.size)
        }
        guard uploaded.count == job.parts.count else { return }
        Task {
            do {
                try await api.complete(videoId: job.videoId, parts: uploaded, durationS: job.durationS)
                RecordingStore.update(id: job.recordingId) {
                    $0.status = .uploaded
                    $0.remoteVideoId = job.videoId
                    $0.progress = 1
                    $0.uploadError = nil
                }
                work.async { self.removeJob(job.recordingId) }
                // Confirm the cloud copy (video + thumbnail), then free local storage.
                await self.freeLocalIfConfirmed(recordingId: job.recordingId, videoId: job.videoId)
            } catch {
                RecordingStore.update(id: job.recordingId) {
                    $0.status = .failed
                    $0.uploadError = "Finish failed: \(error.localizedDescription)"
                }
            }
        }
    }

    // MARK: - Job persistence (serialized on `work`)

    private func jobURL(_ id: UUID) -> URL { jobsDir.appendingPathComponent("\(id.uuidString).json") }
    private func jobDir(_ id: UUID) -> URL { jobsDir.appendingPathComponent(id.uuidString, isDirectory: true) }

    private func saveJob(_ job: UploadJob) {
        if let data = try? JSONEncoder().encode(job) { try? data.write(to: jobURL(job.recordingId), options: .atomic) }
    }
    private func loadJob(_ id: UUID) -> UploadJob? {
        guard let data = try? Data(contentsOf: jobURL(id)) else { return nil }
        return try? JSONDecoder().decode(UploadJob.self, from: data)
    }
    private func removeJob(_ id: UUID) {
        try? FileManager.default.removeItem(at: jobURL(id))
        try? FileManager.default.removeItem(at: jobDir(id))
    }
    private func allJobs() -> [UploadJob] {
        let files = (try? FileManager.default.contentsOfDirectory(at: jobsDir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap {
            guard let data = try? Data(contentsOf: $0) else { return nil }
            return try? JSONDecoder().decode(UploadJob.self, from: data)
        }
    }
}

// MARK: - URLSession delegate

extension BackgroundUploader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let desc = task.taskDescription else { return }
        let comps = desc.split(separator: "|")
        guard comps.count == 2, let recordingId = UUID(uuidString: String(comps[0])), let number = Int(comps[1]) else { return }

        let http = task.response as? HTTPURLResponse
        let status = http?.statusCode ?? -1

        if let error = error as NSError? {
            if error.code == NSURLErrorCancelled { return } // we cancelled it deliberately
            fail(recordingId, "Network error: \(error.localizedDescription)")
            return
        }
        guard (200..<300).contains(status) else {
            fail(recordingId, "Part \(number) rejected by storage (HTTP \(status)).")
            return
        }
        let etag = http?.value(forHTTPHeaderField: "Etag")?.replacingOccurrences(of: "\"", with: "")
        guard let etag, !etag.isEmpty else {
            fail(recordingId, "Part \(number) uploaded but no ETag returned (HTTP \(status)).")
            return
        }

        work.async {
            guard var job = self.loadJob(recordingId),
                  let idx = job.parts.firstIndex(where: { $0.number == number }) else { return }
            job.parts[idx].etag = etag
            self.saveJob(job)
            try? FileManager.default.removeItem(at: self.jobDir(recordingId).appendingPathComponent(job.parts[idx].file))
            let progress = Double(job.uploadedBytes) / Double(max(job.size, 1))
            RecordingStore.update(id: recordingId) { if $0.status == .uploading { $0.progress = progress } }
            if job.allUploaded { self.complete(job) }
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            let handler = self.backgroundCompletion
            self.backgroundCompletion = nil
            handler?()
        }
    }
}
