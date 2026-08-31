import AVFoundation
import Combine
import Foundation

/// The local library of recordings made on this phone. Persists an index to
/// Documents (via `RecordingStore`) so a match survives app restarts until it's
/// uploaded, and reflects upload status/progress driven by the
/// `BackgroundUploader` — which can update recordings even after the app was
/// suspended or relaunched.
@MainActor
final class RecordingLibrary: ObservableObject {
    @Published private(set) var recordings: [Recording] = []
    /// Uploaded matches that live only in the cloud (not recorded on / kept by this
    /// phone). Fetched from the web, merged into the list for display.
    @Published private(set) var cloud: [Recording] = []
    @Published var lastError: String?
    /// Set when a match the app never finished filing has been restored, so the
    /// library can tell you rather than silently growing an entry.
    @Published var recoveredNotice: String?

    /// Server-derived status per uploaded match, keyed by remote video id. Kept
    /// out of `Recording` (and so out of the on-disk index) because it's a live
    /// view of the server, not something this phone owns.
    @Published private(set) var cloudStatus: [String: MatchStatus] = [:]

    /// The server's view of a match, if it's in the cloud and we've fetched it.
    func status(for recording: Recording) -> MatchStatus? {
        guard let id = recording.remoteVideoId else { return nil }
        return cloudStatus[id]
    }

    private let api = UploadAPI()

    /// The full list to show: this account's local recordings + its cloud-only
    /// matches, newest first.
    ///
    /// The filter is the account boundary. `recordings` is the on-disk index for
    /// the *phone*, not for a user, so after a sign-out it still holds whatever
    /// the previous account recorded here — and showing that to whoever signs in
    /// next leaks their match titles, thumbnails and dates. `cloudStatus` is the
    /// server's answer to "what can this account see", so an already-uploaded
    /// recording is shown only when the server agrees it belongs to this account.
    /// A recording that has never been uploaded has no owner on the server yet
    /// and is genuinely this device's, so it stays.
    var displayed: [Recording] {
        (mineOnThisPhone + cloud).sorted { $0.createdAt > $1.createdAt }
    }

    /// Local recordings this account is entitled to see.
    private var mineOnThisPhone: [Recording] {
        recordings.filter { r in
            guard let remoteId = r.remoteVideoId else { return true }  // never uploaded — this phone's
            return cloudStatus[remoteId] != nil                        // uploaded — only if the server shows it to us
        }
    }

    /// Forget everything belonging to the account that just signed out.
    ///
    /// This object is a `@StateObject` on `RootView`, which stays mounted across
    /// sign-out, so without this the next account inherits the last one's cloud
    /// list — and `refreshFromCloud`'s TTL means it would not even re-fetch for a
    /// minute. The on-disk recordings are left alone: they are the phone's, and
    /// `displayed` is what decides who may see them.
    func clearForSignOut() {
        cloud = []
        cloudStatus = [:]
        lastCloudRefresh = nil
        lastError = nil
    }

    /// Whether a recording's video file is present on this phone (vs. cloud-only).
    func hasLocalFile(_ recording: Recording) -> Bool {
        !recording.fileName.isEmpty && FileManager.default.fileExists(atPath: fileURL(for: recording).path)
    }

    /// How many recordings still need uploading (drives the shelf's upload alert).
    var pendingCount: Int {
        recordings.filter { $0.status == .pending || $0.status == .failed }.count
    }

    static var documentsURL: URL { RecordingStore.documentsURL }

    private var observer: NSObjectProtocol?

    init() {
        recordings = RecordingStore.load()

        // An "uploading" recording with no live background job died between
        // launches — surface it as failed so it can be retried. The progress is
        // left where it was rather than zeroed: a retry now resumes from the
        // parts already in storage, so that bar is still true.
        var fixed = false
        for i in recordings.indices where recordings[i].status == .uploading {
            if !BackgroundUploader.shared.hasActiveJob(recordings[i].id) {
                recordings[i].status = .failed
                fixed = true
            }
        }
        if fixed { RecordingStore.save(recordings) }

        // Refresh whenever the store changes (progress/finish from the uploader).
        observer = NotificationCenter.default.addObserver(
            forName: RecordingStore.didChange, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.recordings = RecordingStore.load() }
        }

        BackgroundUploader.shared.resume()

        // Pick up anything a crash, a kill or a dead battery left behind.
        Task { await recoverInterrupted() }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func fileURL(for recording: Recording) -> URL {
        Self.documentsURL.appendingPathComponent(recording.fileName)
    }

    /// File a recording whose video is already sitting in Documents.
    ///
    /// Capture writes straight to its final path now, so there is nothing to move
    /// — which is the point: an interrupted match is already where it belongs and
    /// only needs indexing. Returns the existing entry if it has already been
    /// filed, so recovery and the normal finish path can't produce duplicates.
    @discardableResult
    func adopt(id: UUID, fileName: String, title: String,
               durationS: Double, createdAt: Date = Date()) -> Recording? {
        if let existing = recordings.first(where: { $0.id == id }) { return existing }
        let url = Self.documentsURL.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? Int) ?? 0
        guard size > 0 else { return nil }

        let recording = Recording(
            id: id,
            title: title.isEmpty ? "Untitled match" : title,
            fileName: fileName,
            createdAt: createdAt,
            durationS: durationS,
            sizeBytes: size
        )
        recordings.insert(recording, at: 0)
        recordings.sort { $0.createdAt > $1.createdAt }
        RecordingStore.save(recordings)
        return recording
    }

    /// Move a file into the library as a pending upload. Only the recovery path
    /// needs this now — for a stray `match-*.mov` left in `tmp` by a build that
    /// recorded there.
    @discardableResult
    func add(tempFileURL: URL, title: String, durationS: Double) -> Recording? {
        let id = UUID()
        let fileName = "\(id.uuidString).mov"
        let dest = Self.documentsURL.appendingPathComponent(fileName)
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: tempFileURL, to: dest)
        } catch {
            try? FileManager.default.copyItem(at: tempFileURL, to: dest)
        }
        let created = (try? tempFileURL.resourceValues(forKeys: [.creationDateKey]))?.creationDate
        return adopt(id: id, fileName: fileName, title: title,
                     durationS: durationS, createdAt: created ?? Date())
    }

    // MARK: - Crash recovery

    /// Adopt any recording the app never got to file.
    ///
    /// Three sources, in order of how much we know about them:
    ///   1. the in-progress note, written when capture began — the phone died
    ///      mid-match, and this says exactly which file and when it started;
    ///   2. `match-*.mov` in `tmp`, left by a build that recorded there;
    ///   3. any `<uuid>.mov` in Documents that the index doesn't mention, which
    ///      catches anything the first two miss.
    ///
    /// Duration comes from the file itself, never from wall-clock: for a match cut
    /// short by a dead battery there is no record of when it stopped.
    /// `AVCaptureMovieFileOutput` writes movie fragments as it goes (every 10 s by
    /// default) precisely so an interrupted file stays readable, so this generally
    /// recovers everything up to the last fragment.
    func recoverInterrupted() async {
        var recovered: [Recording] = []

        if let note = RecordingStore.inProgressRecording() {
            let url = Self.documentsURL.appendingPathComponent(note.fileName)
            let seconds = await Self.durationOf(url)
            if let rec = adopt(id: note.id, fileName: note.fileName, title: "",
                               durationS: seconds, createdAt: note.startedAt) {
                recovered.append(rec)
            }
            RecordingStore.clearInProgress()
        }

        let tmp = FileManager.default.temporaryDirectory
        for url in (try? FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? []
        where url.pathExtension.lowercased() == "mov" && url.lastPathComponent.hasPrefix("match-") {
            let seconds = await Self.durationOf(url)
            if let rec = add(tempFileURL: url, title: "", durationS: seconds) {
                recovered.append(rec)
            }
        }

        let known = Set(recordings.map { $0.fileName })
        for url in (try? FileManager.default.contentsOfDirectory(at: Self.documentsURL, includingPropertiesForKeys: nil)) ?? []
        where url.pathExtension.lowercased() == "mov" && !known.contains(url.lastPathComponent) {
            guard let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent) else { continue }
            let seconds = await Self.durationOf(url)
            let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
            if let rec = adopt(id: id, fileName: url.lastPathComponent, title: "",
                               durationS: seconds, createdAt: created ?? Date()) {
                recovered.append(rec)
            }
        }

        guard !recovered.isEmpty else { return }
        let total = recovered.reduce(0) { $0 + $1.sizeBytes }
        UploadLog.info("recovered \(recovered.count) interrupted recording(s), \(total) bytes")
        recoveredNotice = recovered.count == 1
            ? "A recording that was interrupted has been restored to your matches. Upload it when you're ready."
            : "\(recovered.count) interrupted recordings have been restored to your matches."
    }

    /// The real duration of a file on disk, or 0 if it can't be read.
    private static func durationOf(_ url: URL) async -> Double {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration) else { return 0 }
        let seconds = CMTimeGetSeconds(duration)
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    /// Rename a recording (empty → "Untitled match").
    func rename(_ recording: Recording, to newTitle: String) {
        guard let i = recordings.firstIndex(where: { $0.id == recording.id }) else { return }
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        recordings[i].title = trimmed.isEmpty ? "Untitled match" : trimmed
        RecordingStore.save(recordings)
    }

    /// Set who played. Persisted locally so it rides along on the next upload; if
    /// the match is already uploaded, pushed to the server immediately.
    func setParticipants(_ recording: Recording, _ participants: [Participant]) {
        if let i = recordings.firstIndex(where: { $0.id == recording.id }) {
            recordings[i].participants = participants
            RecordingStore.save(recordings)
        }
        if let videoId = recording.remoteVideoId {
            Task { [api] in try? await api.setParticipants(videoId: videoId, participants: participants) }
        }
    }

    /// Kick off (or retry) a background upload. Progress and completion arrive
    /// via `RecordingStore` updates, so this returns immediately.
    ///
    /// With `analyse`, the AI rally breakdown starts as soon as the upload is
    /// confirmed, using the answers collected before it began — the whole point
    /// of "Upload & Analyse" is that you don't come back and ask for it again.
    /// Kick off (or retry) an upload with the shelf's answers.
    ///
    /// The players named in the shelf are tagged on the match here, before the
    /// upload starts, so they ride along on `initiate` (and their invites go out)
    /// rather than costing a second round trip. With `analyse`, the breakdown
    /// starts the moment the upload is confirmed, using the same answers.
    func upload(_ recording: Recording, setup: MatchSetup? = nil, analyse: Bool = false) {
        guard recordings.contains(where: { $0.id == recording.id }) else { return }
        var current = recordings.first { $0.id == recording.id } ?? recording

        if let setup {
            let merged = setup.participants(mergedWith: current.participants ?? [])
            if merged != (current.participants ?? []) {
                setParticipants(current, merged)
                current.participants = merged
            }
        }

        BackgroundUploader.shared.start(
            recording: current,
            fileURL: fileURL(for: current),
            analyse: analyse ? (setup?.analysisRequest ?? AnalysisRequest()) : nil
        )
    }

    /// Proactive, user-initiated delete. Removes the match everywhere: cancels any
    /// upload, deletes the cloud copy (if uploaded), and clears the local file,
    /// thumbnail and index entry. This is the ONLY path that removes the cloud copy.
    func delete(_ recording: Recording) {
        BackgroundUploader.shared.cancel(recording.id)
        if let videoId = recording.remoteVideoId {
            Task { try? await api.deleteVideo(videoId: videoId) }
        }
        if !recording.fileName.isEmpty {
            try? FileManager.default.removeItem(at: fileURL(for: recording))
        }
        Thumbnailer.delete(id: recording.id)
        recordings.removeAll { $0.id == recording.id }
        cloud.removeAll { $0.id == recording.id }
        RecordingStore.save(recordings)
    }

    /// Fetch the signed-in user's library from the web and merge in any matches
    /// that aren't already represented locally. `/api/videos` returns the caller's
    /// whole library — matches they own, were tagged in, or saved — so Matches
    /// shows all of them (not just ones recorded on this phone).
    /// When the cloud list was last fetched, so returning to the tab doesn't
    /// re-hit the network on every appearance.
    private var lastCloudRefresh: Date?
    private static let cloudTTL: TimeInterval = 60

    func refreshFromCloud(force: Bool = false) async {
        if !force, let last = lastCloudRefresh, Date().timeIntervalSince(last) < Self.cloudTTL {
            return
        }
        guard (await Supa.currentUserId()) != nil,
              let videos = try? await api.listVideos() else { return }
        lastCloudRefresh = Date()

        // Server status for every match we can see — including ones already in
        // the local index, which are shown from local state but still need the
        // cloud's view of analysis and sharing.
        cloudStatus = videos.reduce(into: [:]) { map, v in map[v.id] = v.matchStatus }

        let localRemoteIds = Set(mineOnThisPhone.compactMap { $0.remoteVideoId })
        cloud = videos.compactMap { v in
            guard !localRemoteIds.contains(v.id) else { return nil }  // already shown from local index
            guard let uuid = UUID(uuidString: v.id) else { return nil }
            return Recording(
                id: uuid,
                title: v.title,
                fileName: "", // cloud-only — no file on this phone
                createdAt: Self.parseISODate(v.createdAt),
                durationS: v.durationS ?? 0,
                sizeBytes: v.sizeBytes ?? 0,
                status: .uploaded,
                remoteVideoId: v.id,
                remoteThumbnailURL: v.thumbnailUrl
            )
        }
    }

    private static func parseISODate(_ iso: String?) -> Date {
        guard let iso else { return Date() }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso) ?? Date()
    }
}
