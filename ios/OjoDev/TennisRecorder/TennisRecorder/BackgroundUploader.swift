import Foundation

/// Persisted plan for one in-flight multipart upload, so it survives the app
/// being suspended, relaunched, or terminated by the system.
private struct UploadJob: Codable {
    let recordingId: UUID
    let videoId: String
    let durationS: Double
    let size: Int
    var parts: [Part]
    /// Start the AI breakdown as soon as the upload completes ("Upload & AI
    /// Analyse"). Optional so jobs written before this existed still decode.
    var analyseWhenDone: Bool?

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
    private static let sessionID = "com.tobykeating.TennisRecorder.dev.bgupload"

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

    func start(recording: Recording, fileURL: URL, analyseWhenDone: Bool = false) {
        RecordingStore.update(id: recording.id) { $0.status = .uploading; $0.progress = 0; $0.uploadError = nil }
        Task.detached { [self] in
            do {
                try await prepareAndEnqueue(recording: recording, fileURL: fileURL,
                                            analyseWhenDone: analyseWhenDone)
            } catch {
                RecordingStore.update(id: recording.id) { $0.status = .failed; $0.uploadError = "Couldn't start upload: \(error.localizedDescription)" }
            }
        }
    }

    private func prepareAndEnqueue(recording: Recording, fileURL: URL,
                                   analyseWhenDone: Bool) async throws {
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

        try? FileManager.default.createDirectory(at: jobDir(recording.id),
                                                 withIntermediateDirectories: true)

        // Plan every part up front, but don't materialise any of them yet — see
        // `topUp` for why the work is done a window at a time.
        let parts: [UploadJob.Part] = (1...partCount).map { number in
            let offset = (number - 1) * partSize
            return .init(number: number, file: "part-\(number)",
                         size: min(partSize, size - offset), etag: nil)
        }

        // Persist the job BEFORE enqueuing, so a fast part can't complete and find
        // no job to record its ETag against.
        let job = UploadJob(recordingId: recording.id, videoId: start.videoId,
                            durationS: recording.durationS, size: size, parts: parts,
                            analyseWhenDone: analyseWhenDone)
        work.sync { saveJob(job) }

        topUp(recording.id, sourceFile: fileURL, partSize: partSize)
    }

    /// How many of a job's parts are on disk and in flight at once.
    ///
    /// Parts used to be *all* written out and *all* presigned before anything was
    /// enqueued, which meant a 6 GB match needed 12 GB free (the video plus a
    /// second copy as part files) and several hundred sequential presign calls
    /// before the first byte moved — by which point the earliest presigned URLs
    /// (1 h TTL) could already have expired. Now a window's worth is prepared at a
    /// time and refilled as parts land, so disk stays bounded and each URL is
    /// minted shortly before it's used.
    private static let window = 6

    /// Parts being sliced/presigned right now, as "<recordingId>|<partNumber>".
    /// A part is invisible to `getAllTasks` between being chosen and its upload
    /// task existing (there's an `await` on the presign in between), so without
    /// this two overlapping top-ups could both claim the same part.
    /// Only ever touched on `work`.
    private var preparing: Set<String> = []

    /// Write, presign and enqueue enough parts to refill the window. Safe to call
    /// at any time: it reconciles against the tasks the session already has, so a
    /// duplicate call can't double-enqueue a part.
    private func topUp(_ id: UUID, sourceFile: URL, partSize: Int) {
        session.getAllTasks { tasks in
            let inFlight = Set(tasks.compactMap { task -> Int? in
                let parts = (task.taskDescription ?? "").split(separator: "|")
                guard parts.count == 2, String(parts[0]) == id.uuidString else { return nil }
                return Int(parts[1])
            })

            self.work.async {
                guard let job = self.loadJob(id) else { return }
                let key = { (n: Int) in "\(id.uuidString)|\(n)" }
                let busy = inFlight.count + self.preparing.count
                let pending = job.parts
                    .filter {
                        $0.etag == nil && !inFlight.contains($0.number)
                            && !self.preparing.contains(key($0.number))
                    }
                    .prefix(max(0, Self.window - busy))
                guard !pending.isEmpty else { return }
                for part in pending { self.preparing.insert(key(part.number)) }

                Task.detached {
                    for part in pending {
                        do {
                            try await self.materialiseAndEnqueue(part, of: job,
                                                                 sourceFile: sourceFile,
                                                                 partSize: partSize)
                            self.work.async { self.preparing.remove(key(part.number)) }
                        } catch {
                            self.work.async { self.preparing.remove(key(part.number)) }
                            self.fail(id, "Couldn't prepare part \(part.number): \(error.localizedDescription)")
                            return
                        }
                    }
                }
            }
        }
    }

    /// Slice one part out of the source video, presign it, and hand it to the
    /// background session. The URL object is passed through as-is — round-tripping
    /// it via a string can corrupt S3's signature.
    private func materialiseAndEnqueue(_ part: UploadJob.Part, of job: UploadJob,
                                       sourceFile: URL, partSize: Int) async throws {
        let dir = jobDir(job.recordingId)
        let fileURL = dir.appendingPathComponent(part.file)

        if !FileManager.default.fileExists(atPath: fileURL.path) {
            let handle = try FileHandle(forReadingFrom: sourceFile)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64((part.number - 1) * partSize))
            let chunk = try handle.read(upToCount: partSize) ?? Data()
            try chunk.write(to: fileURL, options: .atomic)
        }

        let resp = try await api.partURL(videoId: job.videoId, partNumber: part.number)
        var req = URLRequest(url: api.absolutePartURL(resp.url))
        req.httpMethod = "PUT"
        let task = session.uploadTask(with: req, fromFile: fileURL)
        task.taskDescription = "\(job.recordingId.uuidString)|\(part.number)"
        task.resume()
    }

    /// The original video for a job, needed to slice later parts from.
    private func sourceFile(for recordingId: UUID) -> URL? {
        guard let rec = RecordingStore.load().first(where: { $0.id == recordingId }),
              !rec.fileName.isEmpty else { return nil }
        let url = RecordingStore.documentsURL.appendingPathComponent(rec.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
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

    /// Finish anything that's fully uploaded, and refill the window on anything
    /// that isn't — a job whose window drained while the app was dead would
    /// otherwise sit there with no tasks left to wake it.
    private func finalizeCompletedJobs() {
        for job in allJobs() {
            if job.allUploaded {
                complete(job)
            } else if let source = sourceFile(for: job.recordingId),
                      let partSize = job.parts.first?.size {
                topUp(job.recordingId, sourceFile: source, partSize: partSize)
            }
        }
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
                // "Upload & AI Analyse": the breakdown starts the moment the
                // upload is confirmed, so it's already running by the time the
                // match appears. Best-effort — a failure here is reported by the
                // analysis status itself, not as an upload failure.
                if job.analyseWhenDone == true {
                    _ = try? await api.startAnalysis(videoId: job.videoId)
                }
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
            if job.allUploaded {
                self.complete(job)
            } else if let source = self.sourceFile(for: recordingId),
                      let partSize = job.parts.first?.size {
                // A slot just freed up — slice and enqueue the next part.
                self.topUp(recordingId, sourceFile: source, partSize: partSize)
            }
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
