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

    /// The full list to show: local recordings + cloud-only matches, newest first.
    var displayed: [Recording] {
        (recordings + cloud).sorted { $0.createdAt > $1.createdAt }
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
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func fileURL(for recording: Recording) -> URL {
        Self.documentsURL.appendingPathComponent(recording.fileName)
    }

    /// Move a freshly recorded temp file into the library as a pending upload.
    @discardableResult
    func add(tempFileURL: URL, title: String, durationS: Double) -> Recording {
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
        let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs?[.size] as? Int) ?? 0
        let recording = Recording(
            id: id,
            title: title.isEmpty ? "Untitled match" : title,
            fileName: fileName,
            createdAt: Date(),
            durationS: durationS,
            sizeBytes: size
        )
        recordings.insert(recording, at: 0)
        RecordingStore.save(recordings)
        return recording
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

        let localRemoteIds = Set(recordings.compactMap { $0.remoteVideoId })
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
