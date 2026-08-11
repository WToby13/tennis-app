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
///
/// Turn the phone (or tap fullscreen) and it becomes a review surface instead of
/// a page: the video takes the whole screen under a transparent bar, the tab bar
/// goes away, and the only thing below the fold is the rally timeline.
struct WatchView: View {
    let target: WatchTarget
    @ObservedObject var library: RecordingLibrary

    @Environment(\.dismiss) private var dismiss
    /// Compact height means a landscape phone — the cue to go immersive.
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var url: URL?
    @State private var detail: VideoDetailResponse?
    @State private var loadError: String?
    @State private var editing = false
    @State private var setupOpen = false
    @State private var fullscreen = false
    /// Owned here (not by `ReviewPlayer`) so the AI breakdown can seek the same
    /// player when a rally is tapped. Created once the playback URL resolves.
    @State private var playerModel: PlayerModel?
    /// The match's AI breakdown, shared by the portrait panel and the fullscreen
    /// timeline. Held for the whole screen and filled in once the detail lands.
    @StateObject private var analysis = AnalysisModel()

    // Social state (seeded from `detail` once loaded, then driven optimistically).
    @State private var didInitSocial = false
    @State private var liked = false
    @State private var likeCount = 0
    @State private var following = false
    @State private var saved = false
    @State private var sharedToFollowers = false
    @State private var isPublic = false
    @State private var shareCopied = false

    @ObservedObject private var chrome = ChromeState.shared

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

    /// Fullscreen review mode: the phone is on its side, or you asked for it.
    /// Only once there's something to play — an error message shouldn't take over
    /// the screen with no way to read the rest of the page.
    private var immersive: Bool {
        (verticalSizeClass == .compact || fullscreen) && playerModel != nil
    }

    /// A recording on this phone that still needs to go up.
    private var pendingUpload: Recording? {
        guard let rec = localRecording, rec.status == .pending || rec.status == .failed else { return nil }
        return rec
    }

    var body: some View {
        Group {
            if immersive, let playerModel {
                FullscreenPlayer(model: playerModel, analysis: analysis, onExit: exitImmersive)
            } else {
                page
            }
        }
        .background(Theme.bg)
        .navigationTitle(immersive ? "" : title)
        .navigationBarTitleDisplayMode(.inline)
        // Fullscreen means fullscreen: no bar, no status bar, no home indicator —
        // the back chevron the player draws is the only chrome left.
        .toolbar(immersive ? .hidden : .visible, for: .navigationBar)
        .statusBar(hidden: immersive)
        .persistentSystemOverlays(immersive ? .hidden : .automatic)
        .toolbar {
            if localRecording != nil && !immersive {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { editing = true } label: { Image(systemName: "slider.horizontal.3") }
                }
            }
        }
        // The tab bar is drawn by MainTabView, so ask it to stand down.
        .onAppear { chrome.tabBarHidden = immersive }
        .onChange(of: immersive) { _, on in chrome.tabBarHidden = on }
        .onDisappear {
            chrome.tabBarHidden = false
            playerModel?.pause()
        }
        .task { await load() }
        .sheet(isPresented: $editing) {
            if let rec = localRecording {
                EditSheet(recording: rec, library: library, onDone: { editing = false })
            }
        }
        .sheet(isPresented: $setupOpen) {
            MatchSetupSheet(
                purpose: .beforeUpload,
                existing: localRecording?.participants ?? []
            ) { setup in
                if let rec = pendingUpload { library.upload(rec, setup: setup) }
            } onPrimary: { setup in
                if let rec = pendingUpload { library.upload(rec, setup: setup, analyse: true) }
            }
        }
    }

    /// The back chevron: leave fullscreen if that's where we are by choice,
    /// otherwise leave the match.
    private func exitImmersive() {
        if fullscreen { fullscreen = false } else { dismiss() }
    }

    // MARK: Stage

    private var stage: some View {
        ZStack {
            Color.black
            if let playerModel {
                ReviewPlayer(
                    model: playerModel,
                    // In landscape the screen is already the video, so a toggle
                    // there would be a button that does nothing.
                    onEnterFullscreen: verticalSizeClass == .compact ? nil : { fullscreen = true }
                )
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

    // MARK: Page (portrait)

    private var page: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                stage
                header
                if let rec = pendingUpload {
                    uploadActions(rec)
                }
                if let rec = localRecording, rec.status == .uploading {
                    uploadProgress(rec)
                }
                if let vid = videoId, let d = detail {
                    socialBar(vid: vid, d: d)
                    RallyBreakdown(
                        model: analysis,
                        onSeek: { playerModel?.play(from: $0) },
                        onSetup: { setup, run in applySetup(vid, setup: setup, run: run) },
                        participants: currentParticipants
                    )
                    manageControls(vid: vid, d: d)
                    Divider().overlay(Theme.border).padding(.horizontal, 16)
                    CommentSection(videoId: vid)
                }
            }
            .padding(.bottom, 32)
        }
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

    /// The two ways to get a match off this phone, right under the footage you
    /// just watched back. Both open the shelf — who played is worth recording
    /// either way — and its own buttons decide whether the breakdown runs.
    private func uploadActions(_ rec: Recording) -> some View {
        VStack(spacing: 8) {
            Button { setupOpen = true } label: {
                Label("AI Breakdown", systemImage: "sparkles")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                    .foregroundStyle(Theme.text)
            }
            Button { setupOpen = true } label: {
                Label(rec.status == .failed ? "Retry upload" : "Upload",
                      systemImage: "arrow.up.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .stroke(Theme.border, lineWidth: 1.5))
                    .foregroundStyle(Theme.text)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
    }

    private func uploadProgress(_ rec: Recording) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Uploading… \(Int(rec.progress * 100))%")
                .font(.caption).foregroundStyle(Theme.muted)
            ProgressBar(value: rec.progress)
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
        // Seed the timeline from the duration we already know, so the scrubber is
        // usable before the asset finishes loading.
        playerModel = PlayerModel(url: newURL, knownDuration: durationS)
    }

    private func load() async {
        if let rec = localRecording, library.hasLocalFile(rec) {
            setURL(library.fileURL(for: rec))
        }
        if let vid = videoId {
            do {
                let d = try await api.getVideo(videoId: vid)
                detail = d
                analysis.seed(videoId: vid, detail: d)
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

    /// The match's players as the shelf needs them — from the local copy when we
    /// have one (it's the fresher of the two), otherwise the cloud detail.
    private var currentParticipants: [Participant] {
        if let local = localRecording?.participants, !local.isEmpty { return local }
        return (detail?.participants ?? []).map {
            Participant(userId: $0.userId, displayName: $0.displayName, email: $0.email)
        }
    }

    /// Apply the shelf's answers to a match that's already in the cloud: the two
    /// named players are tagged on it either way, then the breakdown runs (or the
    /// names are just saved).
    private func applySetup(_ vid: String, setup: MatchSetup, run: Bool) {
        if run {
            analysis.run(setup.analysisRequest)
        } else {
            analysis.savePlayers(setup.analysisPlayers)
        }
        Task {
            let existing = currentParticipants
            let merged = setup.participants(mergedWith: existing)
            guard merged != existing else { return }
            if let rec = localRecording {
                library.setParticipants(rec, merged) // saves locally and pushes
            } else {
                try? await api.setParticipants(videoId: vid, participants: merged)
            }
            if let refreshed = try? await api.getVideo(videoId: vid) { detail = refreshed }
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
