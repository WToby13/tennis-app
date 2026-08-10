import SwiftUI
import UIKit

/// What a Watch screen was opened for: a local recording (from Matches or straight
/// after recording) or a cloud match by id (from the feed / a profile).
enum WatchTarget: Hashable {
    case recording(Recording)
    case video(id: String)
}

/// The match screen — review the footage and act on it (like, comment, follow,
/// save, share, and for your own matches manage visibility / delete). Plays a
/// local file when present, otherwise a signed cloud URL, and loads the cloud
/// detail for metadata + social state.
struct WatchView: View {
    let target: WatchTarget
    @ObservedObject var library: RecordingLibrary

    @Environment(\.dismiss) private var dismiss

    @State private var url: URL?
    @State private var detail: VideoDetailResponse?
    @State private var loadError: String?
    @State private var editing = false
    /// Owned here (not by `ReviewPlayer`) so the AI breakdown can seek the same
    /// player when a rally is tapped. Created once the playback URL resolves.
    @State private var playerModel: PlayerModel?

    // Social state (seeded from `detail` once loaded, then driven optimistically).
    @State private var didInitSocial = false
    @State private var liked = false
    @State private var likeCount = 0
    @State private var following = false
    @State private var saved = false
    @State private var sharedToFollowers = false
    @State private var isPublic = false
    @State private var shareCopied = false

    private let api = UploadAPI()

    // MARK: Resolved subject

    private var localRecording: Recording? {
        switch target {
        case .recording(let r): return library.displayed.first { $0.id == r.id } ?? r
        case .video(let id): return library.displayed.first { $0.remoteVideoId == id }
        }
    }

    private var videoId: String? {
        switch target {
        case .recording: return localRecording?.remoteVideoId
        case .video(let id): return id
        }
    }

    private var title: String {
        if let t = localRecording?.title, !t.isEmpty { return t }
        return detail?.video.title ?? "Match"
    }

    private var date: Date {
        if let r = localRecording { return r.createdAt }
        return parseISODate(detail?.video.createdAt)
    }

    private var durationS: Double {
        localRecording?.durationS ?? detail?.video.durationS ?? 0
    }

    private var playerNames: [String] {
        if let ps = localRecording?.participants {
            return ps.map(\.displayName).filter { !$0.isEmpty }
        }
        return (detail?.participants ?? []).map(\.displayName).filter { !$0.isEmpty }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                stage
                header
                if let rec = localRecording, rec.status == .uploading {
                    uploadProgress(rec)
                }
                if let vid = videoId, let d = detail {
                    socialBar(vid: vid, d: d)
                    RallyBreakdown(
                        videoId: vid,
                        canAnalyze: d.canAnalyze ?? false,
                        initialStatus: d.analysisStatus,
                        initialError: d.analysisError,
                        initialSegments: d.segments ?? [],
                        initialPlayers: d.analysisPlayers,
                        onSeek: { playerModel?.play(from: $0) }
                    )
                    manageControls(vid: vid, d: d)
                    Divider().overlay(Theme.border).padding(.horizontal, 16)
                    CommentSection(videoId: vid)
                }
            }
            .padding(.bottom, 32)
        }
        .background(Theme.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if localRecording != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { editing = true } label: { Image(systemName: "slider.horizontal.3") }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $editing) {
            if let rec = localRecording {
                EditSheet(recording: rec, library: library, onDone: { editing = false })
            }
        }
    }

    // MARK: Stage

    private var stage: some View {
        ZStack {
            Color.black
            if let playerModel {
                ReviewPlayer(model: playerModel)
            } else if let loadError {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").font(.title2)
                    Text(loadError).font(.footnote).multilineTextAlignment(.center)
                }
                .foregroundStyle(.white.opacity(0.8))
                .padding(24)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.title3.bold()).foregroundStyle(Theme.text)
                Spacer()
                if let rec = localRecording {
                    StatusBadge(status: rec.status)
                }
            }
            // Author link (cloud matches with a known author that isn't me).
            if let author = detail?.author, detail?.isOwner != true {
                NavigationLink(value: ProfileTarget.user(id: author.id)) {
                    HStack(spacing: 6) {
                        Avatar(name: author.displayName, size: 22)
                        Text(author.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                    }
                }
                .buttonStyle(.plain)
            }
            Text("\(date.formatted(date: .abbreviated, time: .shortened)) · \(durationString(durationS))")
                .font(.subheadline).foregroundStyle(Theme.muted)
            if !playerNames.isEmpty {
                Text("with " + playerNames.joined(separator: ", "))
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 16)
    }

    private func uploadProgress(_ rec: Recording) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Uploading…").font(.caption).foregroundStyle(Theme.muted)
            ProgressView(value: rec.progress).tint(Theme.accent)
        }
        .padding(.horizontal, 16)
    }

    // MARK: Social bar

    private func socialBar(vid: String, d: VideoDetailResponse) -> some View {
        HStack(spacing: 22) {
            Button { toggleLike(vid) } label: {
                HStack(spacing: 6) {
                    Image(systemName: liked ? "heart.fill" : "heart")
                    if likeCount > 0 { Text("\(likeCount)").font(.subheadline.weight(.semibold)) }
                }
                .foregroundStyle(liked ? Theme.danger : Theme.text)
            }
            Button { share(vid) } label: {
                Image(systemName: shareCopied ? "checkmark" : "square.and.arrow.up")
                    .foregroundStyle(shareCopied ? Theme.sage : Theme.text)
            }
            if d.inLibrary == false {
                Button { save(vid) } label: {
                    Image(systemName: saved ? "bookmark.fill" : "bookmark")
                        .foregroundStyle(saved ? Theme.accent : Theme.text)
                }
            }
            Spacer()
            if d.isOwner != true, let author = d.author {
                Button { toggleFollow(author.id) } label: {
                    Text(following ? "Following" : "Follow")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(following ? Theme.muted : Theme.accent)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .overlay(Capsule().stroke(following ? Theme.border : Theme.accent, lineWidth: 1.5))
                }
                .buttonStyle(.plain)
            }
        }
        .font(.system(size: 22, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
    }

    // MARK: Manage (owner / editor)

    @ViewBuilder
    private func manageControls(vid: String, d: VideoDetailResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if d.canEdit == true {
                Toggle(isOn: Binding(get: { sharedToFollowers }, set: { setShared(vid, $0) })) {
                    Text("Share to followers").foregroundStyle(Theme.text)
                }
                .tint(Theme.accent)
            }
            if d.isOwner == true {
                VStack(alignment: .leading, spacing: 6) {
                    Text("VISIBILITY").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                    Picker("Visibility", selection: Binding(get: { isPublic }, set: { setVisibility(vid, $0) })) {
                        Text("Private").tag(false)
                        Text("Public").tag(true)
                    }
                    .pickerStyle(.segmented)
                }
                Button(role: .destructive) { deleteMatch(vid) } label: {
                    Label("Delete match", systemImage: "trash")
                }
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: Load

    /// Point the stage at a playable URL, building the player model once.
    private func setURL(_ newURL: URL) {
        guard url == nil else { return }
        url = newURL
        playerModel = PlayerModel(url: newURL)
    }

    private func load() async {
        if let rec = localRecording, library.hasLocalFile(rec) {
            setURL(library.fileURL(for: rec))
        }
        if let vid = videoId {
            do {
                let d = try await api.getVideo(videoId: vid)
                detail = d
                initSocial(d)
                if let pb = d.playbackUrl {
                    setURL(api.absolutePartURL(pb))
                }
            } catch {
                if url == nil { loadError = "Couldn't load this match.\nCheck your connection and try again." }
            }
        }
        if url == nil && loadError == nil {
            loadError = videoId == nil
                ? "This match isn't available to play."
                : "This match isn't ready to play yet."
        }
    }

    private func initSocial(_ d: VideoDetailResponse) {
        guard !didInitSocial else { return }
        didInitSocial = true
        liked = d.likedByMe ?? false
        likeCount = d.likeCount ?? 0
        following = d.isFollowingOwner ?? false
        saved = d.inLibrary ?? false
        sharedToFollowers = d.sharedToFollowers ?? false
        isPublic = (d.video.visibility == "public")
    }

    // MARK: Actions (optimistic)

    private func toggleLike(_ vid: String) {
        let n = !liked
        liked = n
        likeCount = max(0, likeCount + (n ? 1 : -1))
        Task {
            if let s = try? await api.setLike(videoId: vid, liked: n) {
                liked = s.likedByMe; likeCount = s.count
            }
        }
    }

    private func toggleFollow(_ userId: String) {
        let n = !following
        following = n
        Task {
            if let f = try? await api.setFollow(userId: userId, following: n) { following = f }
        }
    }

    private func save(_ vid: String) {
        guard !saved else { return }
        saved = true
        Task { _ = try? await api.saveToLibrary(videoId: vid) }
    }

    private func setShared(_ vid: String, _ on: Bool) {
        sharedToFollowers = on
        Task {
            if let s = try? await api.setSharedToFollowers(videoId: vid, shared: on) { sharedToFollowers = s }
        }
    }

    private func setVisibility(_ vid: String, _ pub: Bool) {
        isPublic = pub
        Task { try? await api.setVisibility(videoId: vid, visibility: pub ? "public" : "private") }
    }

    private func share(_ vid: String) {
        Task {
            if let link = try? await api.createShareLink(videoId: vid) {
                UIPasteboard.general.string = Config.apiBaseURL.absoluteString + link.path
                shareCopied = true
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                shareCopied = false
            }
        }
    }

    private func deleteMatch(_ vid: String) {
        if let rec = localRecording {
            library.delete(rec)          // removes local + cloud
        } else {
            Task { try? await api.deleteVideo(videoId: vid) }
        }
        dismiss()
    }
}
