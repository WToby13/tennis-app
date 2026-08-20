import Foundation
import UIKit

/// The AI breakdown's inputs, carried through an upload so "Upload & AI
/// Breakdown" runs with the answers the shelf collected before the bytes moved.
struct AnalysisRequest: Codable, Equatable {
    var startTimeSec: Double?
    var players: AnalysisPlayers?
}

/// Persisted plan for one in-flight multipart upload, so it survives the app
/// being suspended, relaunched, or terminated by the system.
private struct UploadJob: Codable {
    let recordingId: UUID
    let videoId: String
    let durationS: Double
    let size: Int
    /// The part size this job was planned with. Persisted rather than inferred
    /// from `parts.first`, which is only the full part size while part 1 hasn't
    /// been reached — a one-part job would have re-sliced at the wrong offset.
    var partSize: Int?
    var parts: [Part]
    /// Start the AI breakdown as soon as the upload completes ("Upload &
    /// Analyse"), with the start time and player names collected before the
    /// upload began. Optional so jobs written before this existed still decode.
    var analyse: AnalysisRequest?
    /// The pre-shelf form of the above: analyse with no answers. Only ever read,
    /// so a job enqueued by an older build still runs its breakdown.
    var analyseWhenDone: Bool?
    /// Where this job is in its life. Optional so jobs written before it existed
    /// still decode — those were always mid-transfer, i.e. `.active`.
    var state: State?

    enum State: String, Codable {
        /// Parts are still moving.
        case active
        /// Every byte is in storage; only the `complete` call is outstanding.
        case completing
        /// Gave up, and the user has been told. Kept on disk anyway, because it
        /// records which parts storage already has — that's what lets Retry
        /// resume rather than re-upload the whole match.
        case failed
    }

    struct Part: Codable {
        let number: Int
        let file: String // part temp-file name within the job dir
        let size: Int
        var etag: String?
        /// How many times this part's PUT has been retried. Persisted so the
        /// budget survives the app being suspended, woken, or relaunched — a
        /// counter held in memory would reset every time iOS put us to sleep.
        var attempts: Int?
    }

    var stage: State { state ?? .active }
    var slice: Int { partSize ?? parts.first?.size ?? 0 }
    var uploadedBytes: Int { parts.filter { $0.etag != nil }.reduce(0) { $0 + $1.size } }
    var allUploaded: Bool { parts.allSatisfy { $0.etag != nil } }
    var uploadedCount: Int { parts.filter { $0.etag != nil }.count }
}

/// Which job and part a background task belongs to.
///
/// The `videoId` is in here for a reason: a task's description used to be just
/// `recordingId|partNumber`, so a task left over from an abandoned attempt could
/// record its ETag against the *new* attempt's part — an ETag from a completely
/// different multipart upload. `complete` then failed with `InvalidPart`, and
/// the match had to be uploaded again. Now a stale task is recognised and dropped.
private struct TaskRoute {
    let recordingId: UUID
    let videoId: String
    let part: Int

    init?(_ description: String?) {
        let comps = (description ?? "").split(separator: "|")
        guard comps.count == 3,
              let id = UUID(uuidString: String(comps[0])),
              let number = Int(comps[2]) else { return nil }
        recordingId = id
        videoId = String(comps[1])
        part = number
    }

    static func description(_ recordingId: UUID, _ videoId: String, _ part: Int) -> String {
        "\(recordingId.uuidString)|\(videoId)|\(part)"
    }
}

/// Holds a background-task assertion for as long as it's alive, so iOS gives us
/// the runtime to presign and enqueue instead of suspending the app mid-refill.
/// The enqueued uploads keep going either way — it's *our* code that needs the
/// time, and losing it used to strand a job with nothing in flight to wake it.
@MainActor
private final class BackgroundTime {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            UploadLog.error("background time expired during \(name)")
            self?.end()
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// Uploads recordings via a background `URLSession`, so transfers continue while
/// the app is suspended or the screen is off. Every part of the multipart upload
/// is its own background upload task; the system finishes them while we're away,
/// ETags are collected as tasks complete (even across a relaunch), then the
/// upload is completed on the server.
///
/// The design rule throughout: **nothing transient throws the match away.** A
/// 45-minute match is ~300 parts and half an hour of a phone radio, so a dropped
/// connection, a Wi-Fi/cellular hand-off, an S3 `SlowDown`, or a presigned URL
/// that outlived its hour is a near-certainty, not an edge case. Each of those
/// retries its own part with backoff; only a part that fails
/// `maxPartAttempts` times in a row fails the job, and even then the job is kept
/// so Retry resumes from what storage already holds.
final class BackgroundUploader: NSObject {
    static let shared = BackgroundUploader()
    /// The background session's name. iOS keys a session's in-flight tasks to this
    /// string, so changing it orphans any upload already running under the old one
    /// — only ever change it when nothing is mid-transfer.
    private static let sessionID = "com.ojotennis.app.bgupload"

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
        // Low Data Mode and Personal Hotspot both count as "constrained" or
        // "expensive"; a match uploaded from a court is often on exactly those,
        // and silently refusing to move is worse than using the data.
        cfg.allowsExpensiveNetworkAccess = true
        cfg.allowsConstrainedNetworkAccess = true
        cfg.httpMaximumConnectionsPerHost = 4
        // This is an *idle* timeout, not a deadline, and the 60 s default is far
        // too tight for a 20 MB PUT over a phone radio that stalls during a cell
        // hand-off. Tripping it used to fail the whole match.
        cfg.timeoutIntervalForRequest = 300
        cfg.timeoutIntervalForResource = 7 * 24 * 60 * 60
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    private override init() {
        jobsDir = RecordingStore.documentsURL.appendingPathComponent("uploads", isDirectory: true)
        super.init()
        try? FileManager.default.createDirectory(at: jobsDir, withIntermediateDirectories: true)
    }

    /// Whether a recording still has a live background upload job. A job that
    /// gave up is kept on disk (so Retry can resume it) but isn't active — the
    /// library relies on this to show it as failed rather than stuck uploading.
    func hasActiveJob(_ id: UUID) -> Bool {
        guard let job = work.sync(execute: { loadJob(id) }) else { return false }
        return job.stage != .failed
    }

    /// Reconnect the background session (so its delegate is wired after a launch)
    /// and push every job on disk one step further: finish the ones whose parts
    /// all landed, refill the window on the ones still transferring.
    func resume() {
        _ = session
        work.async {
            self.sweepOrphanedSlices()
            self.advanceJobs()
        }
        // Finish freeing local storage for anything uploaded but not yet reclaimed
        // (e.g. the app was killed between completing and verifying).
        Task { await self.reconcileUploaded() }
    }

    /// Delete slice directories whose job is gone. Every abandoned attempt used to
    /// leave its window of slices behind — 23 MB each, and they accumulate with
    /// every retry — on the same volume as the multi-gigabyte match that's trying
    /// to upload. That's a slow squeeze towards the out-of-space failure.
    private func sweepOrphanedSlices() {
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: jobsDir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        for dir in entries {
            guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
            guard let id = UUID(uuidString: dir.lastPathComponent) else { continue }
            guard !FileManager.default.fileExists(atPath: jobURL(id).path) else { continue }
            let slices = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.count ?? 0
            UploadLog.info("reclaiming \(slices) orphaned slice(s) from \(dir.lastPathComponent)")
            try? FileManager.default.removeItem(at: dir)
        }
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

    // MARK: - Start (or resume) an upload

    func start(recording: Recording, fileURL: URL, analyse: AnalysisRequest? = nil) {
        RecordingStore.update(id: recording.id) { $0.status = .uploading; $0.uploadError = nil }
        withBackgroundTime("upload.start") { [self] in
            do {
                try await startOrResume(recording: recording, fileURL: fileURL, analyse: analyse)
            } catch {
                UploadLog.error("start \(recording.id): \(error.localizedDescription)")
                RecordingStore.update(id: recording.id) {
                    $0.status = .failed
                    $0.uploadError = "Couldn't start upload: \(error.localizedDescription)"
                }
            }
        }
    }

    /// Retry never means "start again from zero".
    ///
    /// A previous attempt leaves a job on disk naming an S3 multipart upload
    /// that's still open, so the first thing to do is ask storage what it already
    /// has. A match that died at part 280 of 300 then finishes in a minute
    /// instead of re-sending 5 GB — which is what made every retry as likely to
    /// fail as the attempt before it.
    private func startOrResume(recording: Recording, fileURL: URL,
                               analyse: AnalysisRequest?) async throws {
        // A second tap of Retry while the first is still re-planning would
        // otherwise run two planners over the same job.
        guard work.sync(execute: { planning.insert(recording.id).inserted }) else {
            UploadLog.info("already planning \(recording.id); ignoring the duplicate start")
            return
        }
        defer { work.async { self.planning.remove(recording.id) } }

        if let existing = work.sync(execute: { loadJob(recording.id) }) {
            if await resume(existing, fileURL: fileURL, analyse: analyse) { return }
            UploadLog.info("job \(recording.id) can't be resumed — starting a fresh upload")
            work.sync { removeJob(recording.id) }
        }
        try await beginFreshUpload(recording: recording, fileURL: fileURL, analyse: analyse)
    }

    /// Re-plan an existing job against what storage actually holds. Returns false
    /// if the upload is gone server-side and the caller should start over.
    private func resume(_ job: UploadJob, fileURL: URL, analyse: AnalysisRequest?) async -> Bool {
        // Tasks left from the previous attempt would keep writing into this job
        // while we re-plan it. Stop them first.
        cancelTasks(for: job.recordingId)

        // Then drop every slice the previous attempt left behind. They're valid
        // bytes, but they're a second copy of part of a multi-gigabyte match
        // sitting on the same volume the upload needs to work in — this phone had
        // 17 of them (~390 MB) held for parts that wouldn't be touched for hours,
        // while part 1 couldn't be written for want of space. Re-slicing one is a
        // seek and a 24 MB write; keeping them is what starves the upload.
        let dir = jobDir(job.recordingId)
        let stale = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.count ?? 0
        if stale > 0 {
            UploadLog.info("reclaiming \(stale) slice(s) left by the previous attempt")
            try? FileManager.default.removeItem(at: dir)
        }

        guard let remote = try? await api.listParts(videoId: job.videoId) else {
            // `list-parts` 404s once the multipart upload is closed — which also
            // happens when an earlier `complete` actually succeeded and we never
            // got to record it. Check for that before throwing the bytes away.
            UploadLog.info("resume \(job.videoId): no open upload; checking whether it already finished")
            return await adoptIfAlreadyFinished(job)
        }

        var updated = job
        updated.state = .active
        // Carry the new run's analysis answers, if this retry came from the shelf.
        if let analyse { updated.analyse = analyse }

        let held = Dictionary(remote.parts.map { ($0.partNumber, $0) }, uniquingKeysWith: { a, _ in a })
        var kept = 0
        for i in updated.parts.indices {
            let part = updated.parts[i]
            updated.parts[i].attempts = 0
            guard let there = held[part.number] else { updated.parts[i].etag = nil; continue }
            // A size mismatch means storage was given a different slicing than
            // this plan expects; trusting that ETag would corrupt the assembled
            // video, so re-upload the part instead.
            guard there.size == nil || there.size == part.size else {
                UploadLog.error("resume \(job.videoId): part \(part.number) size \(there.size ?? -1) != \(part.size); re-uploading it")
                updated.parts[i].etag = nil
                continue
            }
            updated.parts[i].etag = there.etag
            kept += 1
        }

        work.sync { saveJob(updated) }
        let percent = Int(Double(updated.uploadedBytes) / Double(max(updated.size, 1)) * 100)
        UploadLog.info("resuming \(job.videoId): \(kept)/\(updated.parts.count) parts already in storage (\(percent)%)")
        RecordingStore.update(id: job.recordingId) {
            $0.status = .uploading
            $0.progress = Double(updated.uploadedBytes) / Double(max(updated.size, 1))
        }

        if updated.allUploaded {
            finish(updated)
        } else {
            topUp(updated.recordingId, videoId: updated.videoId, sourceFile: fileURL, partSize: updated.slice)
        }
        return true
    }

    private func beginFreshUpload(recording: Recording, fileURL: URL,
                                  analyse: AnalysisRequest?) async throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? Int) ?? 0

        // Generate the poster thumbnail now, while the video file is still on disk,
        // so it's ready to upload once the video completes (and survives even if the
        // local video is later removed to free space).
        _ = await Thumbnailer.thumbnail(for: recording.id, videoURL: fileURL)

        let start = try await api.initiate(title: recording.title, contentType: "video/quicktime",
                                           sizeBytes: size, participants: recording.participants ?? [])
        // An invite that couldn't be emailed used to leave no trace anywhere —
        // the inviter's only clue was that their friend never showed up. The link
        // still works, and the match's Players sheet on the web offers it to
        // copy; log it here so the failure is at least visible in a device log.
        for invite in start.invites ?? [] where invite.failed {
            print("[upload] invite email to \(invite.email) failed — link: \(invite.url)")
        }
        let partSize = start.partSizeBytes
        let partCount = max(1, Int(ceil(Double(size) / Double(partSize))))

        // Slices left by an abandoned attempt may have been cut at a different
        // part size, so this upload starts with an empty scratch directory rather
        // than trusting them. (Also reclaims their disk before the check below.)
        try? FileManager.default.removeItem(at: jobDir(recording.id))

        // Check the disk before anything else commits to this upload. Without it
        // the first slice fails with a raw Foundation "volume is out of space"
        // string, after the server has already opened a multipart upload that
        // then sits in the bucket until the lifecycle rule reaps it.
        if let short = spaceShortfall(partSize: partSize) {
            try? await api.abortUpload(videoId: start.videoId)
            UploadLog.error("not enough space: need \(Self.readable(short.needed)), have \(Self.readable(short.free))")
            throw UploadError.server(status: 0, message: outOfSpaceMessage(partSize: partSize))
        }
        try? FileManager.default.createDirectory(at: jobDir(recording.id),
                                                 withIntermediateDirectories: true)

        // Plan every part up front, but don't materialise any of them yet — see
        // `topUp` for why the work is done a window at a time.
        let parts: [UploadJob.Part] = (1...partCount).map { number in
            let offset = (number - 1) * partSize
            return .init(number: number, file: "part-\(number)",
                         size: min(partSize, size - offset), etag: nil, attempts: 0)
        }

        // Persist the job BEFORE enqueuing, so a fast part can't complete and find
        // no job to record its ETag against.
        RecordingStore.update(id: recording.id) { $0.progress = 0 }
        let job = UploadJob(recordingId: recording.id, videoId: start.videoId,
                            durationS: recording.durationS, size: size, partSize: partSize,
                            parts: parts, analyse: analyse, analyseWhenDone: nil, state: .active)
        work.sync { saveJob(job) }
        UploadLog.info("upload \(start.videoId) started: \(size) bytes, \(partCount) parts of \(partSize)")

        topUp(recording.id, videoId: start.videoId, sourceFile: fileURL, partSize: partSize)
    }

    // MARK: - Keeping parts in flight

    /// How many of a job's parts are on disk and in flight at once.
    ///
    /// Parts used to be *all* written out and *all* presigned before anything was
    /// enqueued, which meant a 6 GB match needed 12 GB free (the video plus a
    /// second copy as part files) and several hundred sequential presign calls
    /// before the first byte moved — by which point the earliest presigned URLs
    /// (1 h TTL) could already have expired. Now a window's worth is prepared at a
    /// time and refilled as parts land, so disk stays bounded and each URL is
    /// minted shortly before it's used.
    ///
    /// Sized at 24 rather than 6 because refilling needs *our* code to run, while
    /// the enqueued tasks themselves keep going while the app is suspended. A
    /// 5.6 GB match is ~297 parts, so a window of 6 meant ~50 refills, each one
    /// waiting on iOS to wake the app. At 24 that's ~12 refills. Disk stays
    /// bounded (24 × 19 MB ≈ 450 MB of slices for that match) and 24 URLs are
    /// still minted far inside their 1 h TTL.
    private static let window = 24

    /// How many times one part's PUT is retried before the job gives up. With the
    /// backoff below that's a few minutes of trying — long enough to ride out a
    /// change of network or a bad patch of signal, short enough not to sit
    /// forever on a genuinely broken upload.
    private static let maxPartAttempts = 8

    /// How many times the (small, final) `complete` call is retried. It's cheap
    /// and every byte is already in storage by then, so it's worth being stubborn.
    private static let maxCompleteAttempts = 5

    /// Exponential backoff with jitter, capped. Jitter matters because parts fail
    /// in bunches when a network drops, and retrying them all on the same beat
    /// just reproduces the pile-up that broke them.
    private static func backoff(_ attempt: Int) -> TimeInterval {
        let base = min(60, pow(2, Double(min(attempt, 6))))
        return base + Double.random(in: 0...(base / 2))
    }

    /// Never fill the volume completely. iOS starts misbehaving badly when a
    /// device hits zero — and the match's own video file is sitting on the same
    /// volume, so losing it to a full disk would be catastrophic.
    private static let diskHeadroom = 300 * 1024 * 1024

    /// Bytes free on the volume holding Documents, counting purgeable space the
    /// system would reclaim for an important write.
    private static func freeBytes() -> Int? {
        let values = try? RecordingStore.documentsURL.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage.map(Int.init)
    }

    private static func readable(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// How many parts can be on disk at once given what's actually free.
    ///
    /// A part is written out as a *second* copy before it's uploaded, so a full
    /// window costs `window × partSize` — about 550 MB for a 7 GB match. On a
    /// phone already holding that match there may be nowhere near that much, and
    /// demanding it up front is the difference between a slow upload and no
    /// upload. A window of one still finishes; it just refills more often.
    private func windowSize(partSize: Int) -> Int {
        guard partSize > 0 else { return Self.window }
        guard let free = Self.freeBytes() else { return Self.window }
        let usable = free - Self.diskHeadroom
        guard usable >= partSize else { return 0 }
        return max(1, min(Self.window, usable / partSize))
    }

    /// `(needed, free)` when there isn't room to slice even one part, else nil.
    private func spaceShortfall(partSize: Int) -> (needed: Int, free: Int)? {
        guard let free = Self.freeBytes() else { return nil }
        let needed = partSize + Self.diskHeadroom
        return free < needed ? (needed, free) : nil
    }

    private func outOfSpaceMessage(partSize: Int) -> String {
        let free = Self.freeBytes() ?? 0
        return "This phone is out of storage. Uploading slices the match into chunks as it goes, "
            + "so it needs about \(Self.readable(partSize + Self.diskHeadroom)) free — there's "
            + "\(Self.readable(free)). Free up some space and tap Retry; nothing already uploaded is lost."
    }

    /// Whether a write failed because the volume is full — worth saying plainly
    /// and once, rather than retrying eight times against a disk that can't grow.
    private static func isOutOfSpace(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { return true }
        if ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOSPC) { return true }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            return isOutOfSpace(underlying)
        }
        return false
    }

    /// Jobs whose plan is being rebuilt right now.
    ///
    /// `resume()` is called from three places on launch — the app delegate, the
    /// library's init, and the first `.active` scene phase. All three used to
    /// enter the migration before any of them had written a state back, so a
    /// legacy job was re-planned three times over: three `list-parts` round
    /// trips and three overlapping refills. The window survived that (claims are
    /// serialized on `work`), but it's waste, so only one planner runs per job.
    /// Only ever touched on `work`.
    private var planning: Set<UUID> = []

    /// Parts being sliced/presigned right now, as "<recordingId>|<partNumber>".
    /// A part is invisible to `getAllTasks` between being chosen and its upload
    /// task existing (there's an `await` on the presign in between), so without
    /// this two overlapping top-ups could both claim the same part.
    /// Only ever touched on `work`.
    private var preparing: Set<String> = []

    private func claim(_ id: UUID, _ number: Int) -> Bool {
        let key = "\(id.uuidString)|\(number)"
        guard !preparing.contains(key) else { return false }
        preparing.insert(key)
        return true
    }

    private func release(_ id: UUID, _ number: Int) {
        work.async { self.preparing.remove("\(id.uuidString)|\(number)") }
    }

    /// Write, presign and enqueue enough parts to refill the window. Safe to call
    /// at any time: it reconciles against the tasks the session already has, so a
    /// duplicate call can't double-enqueue a part.
    private func topUp(_ id: UUID, videoId: String, sourceFile: URL, partSize: Int) {
        session.getAllTasks { tasks in
            var inFlight: Set<Int> = []
            for task in tasks {
                let desc = task.taskDescription ?? ""
                guard desc.hasPrefix(id.uuidString + "|") else { continue }
                // Either a task from an abandoned attempt, or one enqueued by a
                // build that didn't stamp the videoId. Either way its ETag can't
                // be trusted against this job, and its bytes are just competing
                // with the live upload for the radio.
                guard let route = TaskRoute(desc), route.videoId == videoId else {
                    UploadLog.info("cancelling stale task \(desc)")
                    task.cancel()
                    continue
                }
                inFlight.insert(route.part)
            }

            self.work.async {
                guard let job = self.loadJob(id), job.videoId == videoId, job.stage == .active else { return }
                let mine = self.preparing.filter { $0.hasPrefix(id.uuidString + "|") }.count
                let window = self.windowSize(partSize: partSize)
                guard window > 0 else {
                    // Not even one slice will fit. Retrying can't help until the
                    // user frees something, so say so rather than stalling at 0%.
                    if inFlight.isEmpty { self.fail(id, self.outOfSpaceMessage(partSize: partSize)) }
                    return
                }
                let room = max(0, window - inFlight.count - mine)
                guard room > 0 else { return }
                // Take the window's worth first and claim only those: claiming
                // inside the filter would claim every remaining part and leak the
                // ones this pass doesn't use, shrinking the window for good.
                let pending = job.parts
                    .filter {
                        $0.etag == nil && !inFlight.contains($0.number)
                            && !self.preparing.contains("\(id.uuidString)|\($0.number)")
                    }
                    .prefix(room)
                guard !pending.isEmpty else { return }
                for part in pending { _ = self.claim(id, part.number) }

                self.withBackgroundTime("upload.topUp") {
                    var enqueued = 0
                    var outOfSpace = false
                    for part in pending {
                        if outOfSpace { self.release(id, part.number); continue }
                        do {
                            try await self.materialiseAndEnqueue(part, of: job, sourceFile: sourceFile,
                                                                 partSize: partSize, notBefore: nil)
                            enqueued += 1
                        } catch {
                            // A refill that can't complete is usually not a failed
                            // upload: whatever is already in flight keeps going and
                            // wakes us again, and `resume()` retries the rest on the
                            // next foreground.
                            UploadLog.error("couldn't prepare part \(part.number) of \(videoId): \(error.localizedDescription)")
                            if Self.isOutOfSpace(error) { outOfSpace = true }
                        }
                        self.release(id, part.number)
                    }
                    if outOfSpace {
                        self.fail(id, self.outOfSpaceMessage(partSize: partSize))
                    } else if enqueued == 0 && inFlight.isEmpty {
                        // Nothing moving and nothing queued: no task will ever call
                        // us back, so this would sit at "uploading" for good.
                        self.fail(id, "Couldn't start uploading any part of this match. Check your connection and tap Retry.")
                    }
                }
            }
        }
    }

    /// Slice one part out of the source video, presign it, and hand it to the
    /// background session. The URL object is passed through as-is — round-tripping
    /// it via a string can corrupt S3's signature.
    private func materialiseAndEnqueue(_ part: UploadJob.Part, of job: UploadJob,
                                       sourceFile: URL, partSize: Int,
                                       notBefore: Date?) async throws {
        let dir = jobDir(job.recordingId)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent(part.file)

        // Re-slice unless a complete, correctly sized slice is already sitting
        // there from an earlier attempt — a truncated one (the app was killed
        // mid-write) would upload as a short part and corrupt the assembly.
        let onDisk = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.size] as? Int
        if onDisk != part.size {
            let handle = try FileHandle(forReadingFrom: sourceFile)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64((part.number - 1) * partSize))
            let chunk = try handle.read(upToCount: partSize) ?? Data()
            try chunk.write(to: fileURL, options: .atomic)
        }

        let resp = try await presign(videoId: job.videoId, partNumber: part.number)
        var req = URLRequest(url: api.absolutePartURL(resp.url))
        req.httpMethod = "PUT"
        let task = session.uploadTask(with: req, fromFile: fileURL)
        task.taskDescription = TaskRoute.description(job.recordingId, job.videoId, part.number)
        // Background sessions honour this as the earliest start, which is how a
        // retry can back off while the app is suspended — a timer in our process
        // wouldn't fire at all.
        if let notBefore { task.earliestBeginDate = notBefore }
        task.resume()
    }

    /// Presign with a short retry of its own. A refill often runs in the seconds
    /// iOS gives us after waking the app for a completed part, and one blocked
    /// round trip there used to fail the entire match.
    private func presign(videoId: String, partNumber: Int) async throws -> PartURLResponse {
        var lastError: Error?
        for attempt in 1...4 {
            do {
                return try await api.partURL(videoId: videoId, partNumber: partNumber)
            } catch {
                lastError = error
                UploadLog.error("presign part \(partNumber) of \(videoId) failed (attempt \(attempt)): \(error.localizedDescription)")
                if attempt < 4 {
                    try? await Task.sleep(nanoseconds: UInt64(Self.backoff(attempt) * 1_000_000_000 / 4))
                }
            }
        }
        throw lastError ?? UploadError.badResponse
    }

    /// The original video for a job, needed to slice later parts from.
    private func sourceFile(for recordingId: UUID) -> URL? {
        guard let rec = RecordingStore.load().first(where: { $0.id == recordingId }),
              !rec.fileName.isEmpty else { return nil }
        let url = RecordingStore.documentsURL.appendingPathComponent(rec.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Cancel and clean up a recording's upload (e.g. when it's deleted). Also
    /// aborts the multipart upload server-side so its parts aren't left in the
    /// bucket waiting on the lifecycle rule.
    func cancel(_ id: UUID) {
        cancelTasks(for: id)
        let videoId = work.sync(execute: { loadJob(id) })?.videoId
        work.async { self.removeJob(id) }
        if let videoId {
            Task { try? await api.abortUpload(videoId: videoId) }
        }
    }

    private func cancelTasks(for id: UUID) {
        session.getAllTasks { tasks in
            // Matched on the raw prefix rather than a parsed route, so a task
            // enqueued by an older build — whose descriptions carried only
            // `recordingId|partNumber` — is cancelled too instead of lingering.
            for t in tasks where (t.taskDescription ?? "").hasPrefix(id.uuidString + "|") { t.cancel() }
        }
    }

    private func fail(_ id: UUID, _ message: String) {
        UploadLog.error("upload for \(id) gave up: \(message)")
        cancelTasks(for: id)
        // The job stays on disk on purpose: it names the multipart upload and the
        // parts storage already holds, which is exactly what Retry needs to pick
        // up where this left off. Marked failed so `advanceJobs` doesn't quietly
        // restart it behind the user's back.
        work.async {
            guard var job = self.loadJob(id) else { return }
            job.state = .failed
            self.saveJob(job)
        }
        RecordingStore.update(id: id) {
            guard $0.status == .uploading else { return } // keep the first failure's reason
            $0.status = .failed
            $0.uploadError = message
        }
    }

    // MARK: - Retry

    /// One part's PUT didn't work out. Retry that part — not the match.
    ///
    /// Everything that reaches here is transient in practice: a dropped
    /// connection, a Wi-Fi/cellular hand-off, an S3 `SlowDown`, or a 403 from a
    /// presigned URL that outlived its hour (the retry mints a fresh one, so that
    /// case heals itself). Failing the whole upload on the first of these is what
    /// made a 45-minute match take three or four attempts to get through.
    private func retryPart(_ route: TaskRoute, reason: String) {
        work.async {
            guard var job = self.loadJob(route.recordingId) else { return }
            guard job.videoId == route.videoId else {
                UploadLog.info("ignoring failure of stale part \(route.part) from \(route.videoId)")
                return
            }
            guard job.stage == .active,
                  let idx = job.parts.firstIndex(where: { $0.number == route.part }),
                  job.parts[idx].etag == nil else { return }

            let attempts = (job.parts[idx].attempts ?? 0) + 1
            job.parts[idx].attempts = attempts
            self.saveJob(job)

            guard attempts <= Self.maxPartAttempts else {
                self.fail(route.recordingId,
                          "Part \(route.part) of \(job.parts.count) failed \(attempts) times (\(reason)). "
                          + "Tap Retry — the \(job.uploadedCount) parts already uploaded are kept.")
                return
            }
            guard let source = self.sourceFile(for: route.recordingId) else {
                self.fail(route.recordingId, "The video file for this match is no longer on this phone, so the upload can't continue.")
                return
            }
            guard self.claim(route.recordingId, route.part) else { return }

            let delay = Self.backoff(attempts)
            UploadLog.info("part \(route.part) of \(route.videoId): \(reason) — retry \(attempts)/\(Self.maxPartAttempts) in \(Int(delay))s")
            let part = job.parts[idx]
            let snapshot = job
            self.withBackgroundTime("upload.retryPart") {
                do {
                    try await self.materialiseAndEnqueue(part, of: snapshot, sourceFile: source,
                                                         partSize: snapshot.slice,
                                                         notBefore: Date().addingTimeInterval(delay))
                } catch {
                    UploadLog.error("couldn't re-enqueue part \(route.part): \(error.localizedDescription)")
                }
                self.release(route.recordingId, route.part)
            }
        }
    }

    // MARK: - Completion

    /// Push every job on disk one step further. Runs on launch, on every return to
    /// the foreground, and whenever iOS wakes us for background session events —
    /// so a job whose window drained while the app was dead can't sit there with
    /// no tasks left to wake it.
    private func advanceJobs() {
        for job in allJobs() {
            switch job.stage {
            case .failed:
                continue // waiting on the user; Retry resumes it from what storage has
            case .completing:
                // Every byte landed but the finish call didn't. Try it again.
                UploadLog.info("retrying the finish step for \(job.videoId)")
                finish(job)
            case .active where job.state == nil:
                // Left by a build with no per-part retry — and whose retry path
                // could stamp an ETag from a *previous* attempt onto this job's
                // parts. Those can't be trusted, so re-check them against storage
                // before carrying on. Happens once: `resume` stamps a state.
                reconcileLegacyJob(job)
            case .active:
                if job.allUploaded {
                    finish(job)
                } else if let source = sourceFile(for: job.recordingId) {
                    topUp(job.recordingId, videoId: job.videoId, sourceFile: source, partSize: job.slice)
                } else {
                    fail(job.recordingId, "The video file for this match is no longer on this phone, so the upload can't continue.")
                }
            }
        }
    }

    /// Re-plan a job inherited from a build that predates per-part retry, against
    /// what storage actually holds. This is the upgrade path for a match that was
    /// stuck failing on the old code: whatever genuinely made it to S3 is kept,
    /// everything else is re-uploaded, and no user action is needed.
    private func reconcileLegacyJob(_ job: UploadJob) {
        guard let source = sourceFile(for: job.recordingId) else {
            fail(job.recordingId, "The video file for this match is no longer on this phone, so the upload can't continue.")
            return
        }
        // Called on `work`, so this claims directly rather than via `work.sync`.
        guard planning.insert(job.recordingId).inserted else { return }
        UploadLog.info("job \(job.videoId) predates per-part retry — re-checking its parts against storage")
        withBackgroundTime("upload.migrate") {
            defer { self.work.async { self.planning.remove(job.recordingId) } }
            if await self.resume(job, fileURL: source, analyse: nil) { return }
            // The multipart upload is gone server-side (aborted, or older than the
            // bucket's 7-day window). Nothing to resume, and silently re-sending
            // gigabytes on a launch would be a rude surprise — leave it for the user.
            UploadLog.error("job \(job.videoId) can't be resumed; it has to start again")
            self.work.sync { self.removeJob(job.recordingId) }
            RecordingStore.update(id: job.recordingId) {
                $0.status = .failed
                $0.progress = 0
                $0.uploadError = "This upload expired and has to start from the beginning. Tap Retry."
            }
        }
    }

    /// Assemble the upload server-side. Called only when every part has an ETag.
    private func finish(_ job: UploadJob) {
        work.async {
            guard var current = self.loadJob(job.recordingId), current.videoId == job.videoId else { return }
            guard current.allUploaded else { return }
            // Latch this before the network call: if the app dies mid-`complete`,
            // the next launch has to know the bytes are safe and only the finish
            // step is outstanding — not re-upload 5 GB to find that out.
            current.state = .completing
            self.saveJob(current)
            let snapshot = current
            self.withBackgroundTime("upload.complete") {
                await self.completeUpload(snapshot)
            }
        }
    }

    /// The last, small POST. Every byte is already in storage by the time this
    /// runs, so a failure here must never throw the transfer away: the job stays
    /// in `.completing` and each `resume()` tries again.
    private func completeUpload(_ job: UploadJob) async {
        var parts = job.parts.compactMap { p -> UploadedPart? in
            guard let etag = p.etag else { return nil }
            return UploadedPart(partNumber: p.number, etag: etag, size: p.size)
        }
        guard parts.count == job.parts.count else { return }

        for attempt in 1...Self.maxCompleteAttempts {
            do {
                try await api.complete(videoId: job.videoId, parts: parts, durationS: job.durationS)
                UploadLog.info("upload \(job.videoId) complete (\(job.parts.count) parts)")
                await markUploaded(job)
                return
            } catch {
                UploadLog.error("complete \(job.videoId) failed (attempt \(attempt)): \(error.localizedDescription)")

                // An earlier attempt may already have landed and only the reply
                // got lost — in which case there's nothing left to do.
                if await adoptIfAlreadyFinished(job) { return }

                // S3 rejects the whole call if a single ETag is wrong. Its own
                // part list is authoritative, so rebuild from that rather than
                // insisting on what we recorded.
                if let remote = try? await api.listParts(videoId: job.videoId),
                   remote.parts.count == job.parts.count {
                    UploadLog.info("rebuilding the part list for \(job.videoId) from storage")
                    parts = remote.parts
                        .sorted { $0.partNumber < $1.partNumber }
                        .map { UploadedPart(partNumber: $0.partNumber, etag: $0.etag, size: $0.size ?? 0) }
                }

                if attempt < Self.maxCompleteAttempts {
                    try? await Task.sleep(nanoseconds: UInt64(Self.backoff(attempt) * 1_000_000_000))
                }
            }
        }

        // Deliberately left in `.completing`, not `.failed`: the next foreground
        // retries the finish on its own, and if the user taps Retry first, that
        // resumes to the same place instead of re-uploading the match.
        UploadLog.error("gave up finishing \(job.videoId) for now; it will be retried")
        RecordingStore.update(id: job.recordingId) {
            $0.status = .failed
            $0.uploadError = "The video uploaded, but finishing it didn't go through. It'll retry automatically — or tap Retry; it won't upload the video again."
        }
    }

    /// Whether the server already holds a finished copy for this job. True when an
    /// earlier `complete` landed but we never got to record it — the app was
    /// suspended mid-call, or killed right after. Adopts it when so.
    private func adoptIfAlreadyFinished(_ job: UploadJob) async -> Bool {
        guard let detail = try? await api.getVideo(videoId: job.videoId) else { return false }
        guard detail.video.status == "ready" || detail.video.status == "processing" else { return false }
        UploadLog.info("\(job.videoId) was already finished server-side; adopting it")
        await markUploaded(job)
        return true
    }

    /// Record a finished upload: mark the recording, drop the job and its slices,
    /// chain the AI breakdown, then free local storage once the cloud is confirmed.
    private func markUploaded(_ job: UploadJob) async {
        RecordingStore.update(id: job.recordingId) {
            $0.status = .uploaded
            $0.remoteVideoId = job.videoId
            $0.progress = 1
            $0.uploadError = nil
        }
        work.async { self.removeJob(job.recordingId) }

        // "Upload & Analyse": the breakdown starts the moment the upload is
        // confirmed — with the start time and player names from the shelf — so
        // it's already running by the time the match appears. Best-effort: a
        // failure here is reported by the analysis status itself, not as an
        // upload failure.
        if let analyse = job.analyse {
            _ = try? await api.startAnalysis(videoId: job.videoId,
                                             startTimeSec: analyse.startTimeSec,
                                             players: analyse.players)
        } else if job.analyseWhenDone == true {
            _ = try? await api.startAnalysis(videoId: job.videoId)
        }
        // Confirm the cloud copy (video + thumbnail), then free local storage.
        await freeLocalIfConfirmed(recordingId: job.recordingId, videoId: job.videoId)
    }

    // MARK: - Background time

    /// Run `body` holding a background-task assertion, so iOS grants the seconds
    /// it needs rather than suspending us part-way through.
    private func withBackgroundTime(_ name: String, _ body: @escaping () async -> Void) {
        Task.detached(priority: .utility) {
            let time = await BackgroundTime(name)
            await body()
            await time.end()
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
        guard let route = TaskRoute(task.taskDescription) else { return }

        let http = task.response as? HTTPURLResponse
        let status = http?.statusCode ?? -1

        if let error = error as NSError? {
            if error.code == NSURLErrorCancelled { return } // we cancelled it deliberately
            retryPart(route, reason: error.localizedDescription)
            return
        }
        guard (200..<300).contains(status) else {
            retryPart(route, reason: "HTTP \(status)")
            return
        }
        let etag = http?.value(forHTTPHeaderField: "Etag")?.replacingOccurrences(of: "\"", with: "")
        guard let etag, !etag.isEmpty else {
            retryPart(route, reason: "no ETag in the response")
            return
        }

        work.async {
            guard var job = self.loadJob(route.recordingId), job.videoId == route.videoId,
                  let idx = job.parts.firstIndex(where: { $0.number == route.part }) else {
                // A part of an upload we've since abandoned. Its bytes are in the
                // bucket but belong to a different multipart upload; the abort
                // lifecycle rule reclaims them.
                UploadLog.info("dropping ETag for stale part \(route.part) of \(route.videoId)")
                return
            }
            job.parts[idx].etag = etag
            self.saveJob(job)
            try? FileManager.default.removeItem(at: self.jobDir(route.recordingId).appendingPathComponent(job.parts[idx].file))
            let progress = Double(job.uploadedBytes) / Double(max(job.size, 1))
            RecordingStore.update(id: route.recordingId) { if $0.status == .uploading { $0.progress = progress } }

            if job.allUploaded {
                self.finish(job)
            } else if let source = self.sourceFile(for: route.recordingId) {
                // A slot just freed up — slice and enqueue the next part.
                self.topUp(route.recordingId, videoId: job.videoId, sourceFile: source, partSize: job.slice)
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
