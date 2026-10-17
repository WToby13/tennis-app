import SwiftUI
import UIKit

/// What a Watch screen was opened for: a local recording (from Matches or straight
/// after recording) or a cloud match by id (from the feed / a profile).
enum WatchTarget: Hashable {
    case recording(Recording)
    case video(id: String)
}

/// Somewhere on the watch page worth scrolling to by name.
private enum PageAnchor: Hashable {
    case comments
}

/// What the stage shows: the video, the video with our tracking over it, or the
/// match rebuilt in 3D.
enum StageMode: Hashable {
    case video, tracking, threeD
}

/// The match screen — review the footage and act on it (like, comment, follow,
/// save, share, and for your own matches manage visibility / delete). Plays a
/// local file when present, otherwise a signed cloud URL, and loads the cloud
/// detail for metadata + social state.
///
/// For a recording made on this phone it also follows the match up into the
/// cloud: uploading (in the background), being prepared, being analysed — and
/// re-fetches the match at each step, so the screen fills in as the server does
/// rather than needing to be reopened.
///
/// Turn the phone (or tap fullscreen) and it becomes a review surface instead of
/// a page: the video takes the whole screen under a transparent bar, the tab bar
/// goes away, and the only thing below the fold is the rally timeline.
struct WatchView: View {
    let target: WatchTarget
    @ObservedObject var library: RecordingLibrary
    /// Set when the screen was opened from a notification, which is about the
    /// conversation rather than the match — so land on it.
    var startAtComments = false

    @Environment(\.dismiss) private var dismiss
    /// Compact height means a landscape phone — the cue to go immersive.
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var url: URL?
    @State private var detail: VideoDetailResponse?
    @State private var loadError: String?
    @State private var setupOpen = false
    @State private var fullscreen = false
    /// Owned here (not by `ReviewPlayer`) so the AI breakdown can seek the same
    /// player when a rally is tapped. Created once the playback URL resolves.
    @State private var playerModel: PlayerModel?
    /// The match's AI breakdown, shared by the portrait panel and the fullscreen
    /// timeline. Held for the whole screen and filled in once the detail lands.
    @StateObject private var analysis = AnalysisModel()
    /// Our own analysis: the numbers, the tracking and the 3D scene.
    @StateObject private var insights = InsightsModel()
    @State private var stageMode: StageMode = .video
    /// Built the first time the 3D view is opened, then kept for the screen, so
    /// flipping back and forth keeps the camera where you left it.
    @State private var replay: Replay3DController?

    // Social state (seeded from `detail` once loaded, then driven optimistically).
    @State private var didInitSocial = false
    @State private var liked = false
    @State private var likeCount = 0
    @State private var following = false
    @State private var saved = false
    @State private var sharedToFollowers = false
    @State private var isPublic = false
    @State private var sharePayload: SharePayload?
    @State private var preparingShare = false
    /// Kept in step by the comment list so the bubble can carry a count.
    @State private var commentCount = 0

    @ObservedObject private var chrome = ChromeState.shared

    private let api = UploadAPI()

    // MARK: Resolved subject

    private var localRecording: Recording? {
        switch target {
        case .recording(let r): return library.displayed.first { $0.id == r.id } ?? r
        case .video(let id): return library.displayed.first { $0.remoteVideoId == id }
        }
    }

    /// The recording when it was made on (and is indexed by) this phone — not a
    /// cloud-only entry the library lists alongside them. Only these can be
    /// uploaded, and only these are certainly yours.
    private var phoneRecording: Recording? {
        guard let rec = localRecording, library.recordings.contains(where: { $0.id == rec.id }) else { return nil }
        return rec
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
        guard let rec = phoneRecording, rec.status == .pending || rec.status == .failed else { return nil }
        return rec
    }

    private var stageTracks: MatchTracks? { stageMode == .tracking ? insights.tracks : nil }
    private var stageReplay: Replay3DController? { stageMode == .threeD ? replay : nil }

    var body: some View {
        Group {
            if immersive, let playerModel {
                FullscreenPlayer(model: playerModel, analysis: analysis, onExit: exitImmersive,
                                 tracks: stageTracks, replay: stageReplay,
                                 modes: modeOptions, mode: stageMode, onSelectMode: select)
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
            if canManage && !immersive {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { setupOpen = true } label: { Image(systemName: "slider.horizontal.3") }
                        .accessibilityLabel("Match settings")
                }
            }
            // Someone else's match: report it, or block whoever posted it. The
            // watch screen is where a reviewer looks for this first, because it
            // is where the content is actually being consumed.
            if !immersive, detail?.isOwner != true, let author = detail?.author, let vid = videoId {
                ToolbarItem(placement: .topBarTrailing) {
                    ModerationMenu(
                        target: .match(id: vid, authorId: author.id, authorName: author.displayName),
                        onBlocked: { dismiss() }
                    )
                }
            }
        }
        // The tab bar is drawn by MainTabView, so ask it to stand down.
        .onAppear {
            chrome.tabBarHidden = immersive
            // Straight off the camera: the shelf is the next thing anyone wants —
            // name it, say who played, send it up.
            if let rec = phoneRecording, library.justRecorded == rec.id {
                library.justRecorded = nil
                setupOpen = true
            }
        }
        .onChange(of: immersive) { _, on in chrome.tabBarHidden = on }
        .onDisappear {
            chrome.tabBarHidden = false
            playerModel?.pause()
        }
        // Keyed on the match id, so a recording that finishes uploading while
        // you're looking at it is fetched from the server the moment it lands.
        .task(id: videoId) { await load() }
        // While the server is still preparing the video, check back.
        .task(id: detail?.video.status) { await followServer() }
        // The numbers, again whenever a breakdown finishes.
        .task(id: InsightsKey(videoId: videoId, analysis: analysis.status, upload: detail?.video.status)) {
            guard let vid = videoId, detail?.video.status == "ready" else { return }
            await insights.load(videoId: vid)
        }
        .sheet(isPresented: $setupOpen) { setupSheet }
        .sheet(item: $sharePayload) { payload in
            ShareSheet(url: payload.url)
        }
    }

    private struct InsightsKey: Hashable {
        let videoId: String?
        let analysis: String
        let upload: String?
    }

    // MARK: Setup shelf

    /// One shelf for everything about the match — its name, when play starts, who
    /// played, and what to do with it — opened from the settings button, the
    /// upload buttons and the breakdown panel alike. What it offers depends on
    /// where the match is: still on this phone, on its way up, or in the cloud.
    private var setupSheet: some View {
        MatchSetupSheet(
            purpose: shelfPurpose,
            existing: currentParticipants,
            subject: subject,
            initialPlayers: phoneRecording?.analyseOnUpload?.players ?? analysis.players,
            initialStartTimeSec: phoneRecording?.analyseOnUpload?.startTimeSec,
            canRunBreakdown: canRunBreakdown,
            statusNote: shelfNote,
            shareURL: { await shareTarget() },
            onDelete: canDelete ? { deleteMatch() } : nil,
            onSecondary: { setup in apply(setup, run: false) },
            onPrimary: { setup in apply(setup, run: true) }
        )
    }

    private var shelfPurpose: MatchSetupSheet.Purpose {
        guard let rec = phoneRecording else { return .cloudMatch }
        switch rec.status {
        case .pending, .failed: return .beforeUpload
        case .uploading: return .uploading
        case .uploaded: return .cloudMatch
        }
    }

    private var shelfNote: String? {
        guard let rec = phoneRecording, rec.status == .uploading else { return nil }
        let queued = rec.analyseOnUpload != nil ? " The AI analysis starts as soon as it's up." : ""
        return "Uploading — \(Int(rec.progress * 100))%. Changes here are sent when it finishes.\(queued)"
    }

    /// The owner runs breakdowns. A recording that's still on this phone is
    /// yours by definition; for anything in the cloud, the server says.
    private var canRunBreakdown: Bool {
        if let rec = phoneRecording, rec.status != .uploaded { return true }
        return detail?.canAnalyze ?? analysis.canAnalyze
    }

    /// The match as the shelf shows it — name plus the file's facts.
    private var subject: MatchSubject {
        MatchSubject(
            title: localRecording?.title ?? detail?.video.title ?? "",
            createdAt: date,
            durationS: durationS,
            sizeBytes: localRecording?.sizeBytes ?? detail?.video.sizeBytes ?? 0
        )
    }

    /// Anyone who can edit the match gets the settings shelf; a recording made on
    /// this phone is always yours.
    private var canManage: Bool {
        phoneRecording != nil || detail?.canEdit == true
    }

    private var canDelete: Bool {
        phoneRecording != nil || detail?.isOwner == true
    }

    /// Route the shelf's answers: a recording on this phone goes through the
    /// library (which uploads it, queues the edits behind an upload in flight, or
    /// sends them); the breakdown itself runs here once the match is in the cloud,
    /// so this screen's panel shows it starting.
    private func apply(_ setup: MatchSetup, run: Bool) {
        if let rec = phoneRecording {
            library.apply(setup, to: rec, analyse: run)
            if rec.status == .uploaded, videoId != nil {
                if run { analysis.run(setup.analysisRequest) } else { analysis.savePlayers(setup.analysisPlayers) }
                Task { await refreshDetail() }
            }
            return
        }
        guard let vid = videoId else { return }
        if let title = setup.title, title != detail?.video.title {
            Task {
                try? await api.setTitle(videoId: vid, title: title)
                await refreshDetail()
            }
        }
        applySetup(vid, setup: setup, run: run)
    }

    /// The back chevron: leave fullscreen if that's where we are by choice,
    /// otherwise leave the match.
    private func exitImmersive() {
        if fullscreen { fullscreen = false } else { dismiss() }
    }

    private var hasRallies: Bool { !analysis.segments.isEmpty }

    /// Jump to the next/previous rally from wherever playback is now.
    private func seekRally(_ direction: RallyDirection) {
        guard let playerModel else { return }
        let target = direction == .next
            ? analysis.nextRallyStart(after: playerModel.currentTime)
            : analysis.previousRallyStart(before: playerModel.currentTime)
        if let target { playerModel.play(from: target) }
    }

    // MARK: Stage

    private var stage: some View {
        ZStack {
            Color.black
            if let playerModel {
                ReviewPlayer(
                    model: playerModel,
                    onPreviousRally: hasRallies ? { seekRally(.previous) } : nil,
                    onNextRally: hasRallies ? { seekRally(.next) } : nil,
                    // In landscape the screen is already the video, so a toggle
                    // there would be a button that does nothing.
                    onEnterFullscreen: verticalSizeClass == .compact ? nil : { fullscreen = true },
                    tracks: stageTracks,
                    replay: stageReplay
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

    /// Video, tracking or 3D — offered once our analysis has something to show.
    @ViewBuilder private var stageModes: some View {
        if insights.hasAnalysis, playerModel != nil {
            VStack(alignment: .leading, spacing: 10) {
                StageModePicker(options: modeOptions, current: stageMode, onSelect: select)
                if stageMode == .threeD, let replay {
                    Replay3DViewPicker(controller: replay)
                    Replay3DCredits(controller: replay)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var sceneLabel: String {
        switch insights.sceneState {
        case .loading: return "Loading 3D…"
        case .failed: return "3D · retry"
        default: return "3D"
        }
    }

    /// What the stage can show for this match: the video always, tracking and
    /// 3D once our analysis has them. Shared by the page and fullscreen.
    private var modeOptions: [StageModeOption] {
        guard insights.hasAnalysis else { return [] }
        var out = [StageModeOption(mode: .video, label: "Video", icon: "play.rectangle")]
        if insights.tracksState != .none {
            out.append(StageModeOption(mode: .tracking, label: insights.tracksState == .loading ? "Loading…" : "Tracking", icon: "scope"))
        }
        if insights.sceneState != .none {
            out.append(StageModeOption(mode: .threeD, label: sceneLabel, icon: "cube.transparent"))
        }
        return out
    }

    /// Switch what the stage shows, fetching the tracking or the scene the first
    /// time it's asked for.
    private func select(_ mode: StageMode) {
        switch mode {
        case .video:
            withAnimation(.easeInOut(duration: 0.2)) { stageMode = .video }
        case .tracking:
            Task {
                await insights.loadTracks()
                if insights.tracks != nil { withAnimation(.easeInOut(duration: 0.2)) { stageMode = .tracking } }
            }
        case .threeD:
            Task {
                await insights.loadScene()
                guard let scene = insights.scene, let playerModel else { return }
                if replay == nil { replay = Replay3DController(scene: scene, player: playerModel.player) }
                withAnimation(.easeInOut(duration: 0.2)) { stageMode = .threeD }
                Analytics.track(.threeDViewOpened, videoId: videoId)
            }
        }
    }

    // MARK: Page (portrait)

    private var page: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    stage
                    stageModes
                    header
                    if let rec = phoneRecording, let card = MatchJourney(recording: rec, detail: detail, analysis: analysis.status) {
                        MatchJourneyCard(journey: card,
                                         onUpload: { setupOpen = true },
                                         onRetry: { library.upload(rec, analyse: rec.analyseOnUpload != nil) })
                            .padding(.horizontal, 16)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    if let vid = videoId, let d = detail {
                        socialBar(vid: vid, d: d) {
                            withAnimation { proxy.scrollTo(PageAnchor.comments, anchor: .top) }
                        }
                        RallyBreakdown(
                            model: analysis,
                            onSeek: { playerModel?.play(from: $0) },
                            onOpenSetup: { setupOpen = true }
                        )
                        if let stats = insights.stats {
                            ShotAnalysisView(stats: stats, onSeek: { playerModel?.play(from: $0) })
                        }
                        manageControls(vid: vid, d: d)
                        Divider().overlay(Theme.border).padding(.horizontal, 16)
                        CommentSection(
                            videoId: vid,
                            onSeek: { playerModel?.play(from: $0) },
                            onCountChange: { commentCount = $0 }
                        )
                        .id(PageAnchor.comments)
                    }
                }
                .padding(.bottom, 32)
                .animation(.easeInOut(duration: 0.25), value: phoneRecording?.status)
            }
            .scrollDismissesKeyboard(.interactively)
            // Once the detail lands there is finally a comment section to scroll
            // to. The beat afterwards lets the list lay out first, so this jumps
            // to where the comments end up rather than where they started.
            .task(id: detail?.video.id) {
                guard startAtComments, detail != nil else { return }
                try? await Task.sleep(for: .milliseconds(350))
                withAnimation { proxy.scrollTo(PageAnchor.comments, anchor: .top) }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.title3.bold()).foregroundStyle(Theme.text)
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

    // MARK: Social bar

    private func socialBar(vid: String, d: VideoDetailResponse, onComments: @escaping () -> Void) -> some View {
        HStack(spacing: 22) {
            Button { toggleLike(vid) } label: {
                HStack(spacing: 6) {
                    Image(systemName: liked ? "heart.fill" : "heart")
                    if likeCount > 0 { Text("\(likeCount)").font(.subheadline.weight(.semibold)) }
                }
                .foregroundStyle(liked ? Theme.danger : Theme.text)
            }
            // Sits with like and share because that's where a thumb looks for it;
            // the comments themselves are the length of the page away, so this
            // takes you there rather than opening anything.
            Button(action: onComments) {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.right")
                    if commentCount > 0 { Text("\(commentCount)").font(.subheadline.weight(.semibold)) }
                }
                .foregroundStyle(Theme.text)
            }
            .accessibilityLabel("Go to comments")
            Button { presentShare() } label: {
                Image(systemName: "square.and.arrow.up").foregroundStyle(Theme.text)
            }
            .disabled(preparingShare)
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
                // Delete lives in the settings shelf now — one place for the
                // irreversible thing, behind a confirmation.
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
        let model = PlayerModel(url: newURL, knownDuration: durationS)
        // Capture the id now: by the time this fires the view may have moved on,
        // and an event attributed to the wrong match is worse than no event.
        let watched = videoId
        let owner = detail?.isOwner == true
        model.onFirstPlay = {
            Analytics.track(.watchStarted, videoId: watched, props: ["isOwner": .bool(owner)])
        }
        playerModel = model
    }

    private func load() async {
        if let rec = localRecording, library.hasLocalFile(rec) {
            setURL(library.fileURL(for: rec))
        }
        if let vid = videoId {
            do {
                let d = try await api.getVideo(videoId: vid)
                adopt(d, videoId: vid)
                loadError = nil
            } catch {
                if url == nil { loadError = "Couldn't load this match.\nCheck your connection and try again." }
            }
        }
        if url == nil && loadError == nil && phoneRecording == nil {
            loadError = videoId == nil
                ? "This match isn't available to play."
                : "This match isn't ready to play yet."
        }
    }

    /// Take a fresh copy of the match from the server: social state the first
    /// time, the breakdown's starting point, and somewhere to play it from if
    /// this phone doesn't (or no longer) have the file.
    private func adopt(_ d: VideoDetailResponse, videoId vid: String) {
        detail = d
        analysis.seed(videoId: vid, detail: d)
        initSocial(d)
        guard let pb = d.playbackUrl else { return }
        let remote = api.absolutePartURL(pb)
        if url == nil {
            setURL(remote)
        } else if let current = url, current.isFileURL, !FileManager.default.fileExists(atPath: current.path) {
            // The file was freed once the upload was confirmed; carry on from the cloud copy.
            url = remote
            playerModel?.replaceSource(remote)
        }
    }

    private func refreshDetail() async {
        guard let vid = videoId, let d = try? await api.getVideo(videoId: vid) else { return }
        adopt(d, videoId: vid)
    }

    /// While the server is still preparing an uploaded video, look again every
    /// few seconds. Each answer changes `detail.video.status`, which restarts
    /// this, so it stops by itself once the match is ready.
    private func followServer() async {
        guard let status = detail?.video.status, status == "uploading" || status == "processing" else { return }
        try? await Task.sleep(for: .seconds(5))
        guard !Task.isCancelled else { return }
        await refreshDetail()
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

    /// What to hand the system share sheet: a revocable share link once the match
    /// is in the cloud, otherwise the video file itself, so a recording that
    /// hasn't been uploaded can still be AirDropped or saved.
    private func shareTarget() async -> URL? {
        if let vid = videoId, let link = try? await api.createShareLink(videoId: vid) {
            return URL(string: Config.apiBaseURL.absoluteString + link.path)
        }
        if let rec = localRecording, library.hasLocalFile(rec) {
            return library.fileURL(for: rec)
        }
        return nil
    }

    private func presentShare() {
        guard !preparingShare else { return }
        preparingShare = true
        Task {
            defer { preparingShare = false }
            if let url = await shareTarget() {
                sharePayload = SharePayload(url: url)
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

    /// Apply the shelf's answers to a match that's only in the cloud: the two
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
            try? await api.setParticipants(videoId: vid, participants: merged)
            await refreshDetail()
        }
    }

    private func deleteMatch() {
        if let rec = phoneRecording {
            library.delete(rec)          // removes local + cloud
        } else if let vid = videoId {
            Task { try? await api.deleteVideo(videoId: vid) }
        }
        dismiss()
    }
}

// MARK: - What the stage shows

/// One of the stage's modes, as a chip offers it.
struct StageModeOption: Identifiable {
    let mode: StageMode
    let label: String
    let icon: String
    var id: StageMode { mode }
}

/// Video, Tracking, 3D as a row of chips — under the video on the page, over
/// it in fullscreen.
struct StageModePicker: View {
    let options: [StageModeOption]
    let current: StageMode
    let onSelect: (StageMode) -> Void
    /// Over the picture rather than on the page.
    var onDark = false

    var body: some View {
        // Over the picture the row shares the top bar with the back and speed
        // buttons, so on an upright phone it scrolls rather than cutting a label short.
        if onDark {
            ScrollView(.horizontal, showsIndicators: false) { chips }
        } else {
            chips
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            ForEach(options) { o in
                let on = current == o.mode
                Button { onSelect(o.mode) } label: {
                    Label(o.label, systemImage: o.icon)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, onDark ? 10 : 12).padding(.vertical, onDark ? 7 : 8)
                        .background(on ? Theme.accent : (onDark ? Color.black.opacity(0.45) : Theme.surface2), in: Capsule())
                        .foregroundStyle(on ? Theme.text : (onDark ? .white : Theme.muted))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            if !onDark { Spacer(minLength: 0) }
        }
    }
}

// MARK: - The match's journey up to the cloud

/// Where a recording made on this phone is on its way to being a finished,
/// analysed match: up, prepared, analysed. Nil once there's nothing left to
/// wait for — the card has done its job and goes away.
struct MatchJourney: Equatable {
    enum StepState: Equatable { case waiting, active, done, failed }

    struct Step: Equatable, Identifiable {
        let id: String
        let state: StepState
    }

    let steps: [Step]
    let headline: String
    let note: String?
    let progress: Double?
    let canRetry: Bool
    /// Not uploaded at all yet: the card offers the two ways to send it.
    let notStarted: Bool

    init?(recording rec: Recording, detail: VideoDetailResponse?, analysis: String) {
        let server = detail?.video.status
        let wantsBreakdown = rec.analyseOnUpload != nil || analysis == "processing" || analysis == "ready" || analysis == "failed"

        let upload: StepState
        switch rec.status {
        case .pending: upload = .waiting
        case .uploading: upload = .active
        case .failed: upload = .failed
        case .uploaded: upload = .done
        }
        let prepare: StepState = upload != .done ? .waiting
            : server == "ready" ? .done
            : server == "failed" ? .failed : .active
        let analyse: StepState = !wantsBreakdown || prepare != .done ? .waiting
            : analysis == "ready" ? .done
            : analysis == "failed" ? .failed
            : .active

        // Finished: uploaded, ready, and either analysed or never asked to be.
        if upload == .done && prepare == .done && (analyse == .done || !wantsBreakdown || analyse == .failed) {
            return nil
        }

        var steps = [Step(id: "Uploaded", state: upload), Step(id: "Ready to play", state: prepare)]
        if wantsBreakdown { steps.append(Step(id: "Analysed", state: analyse)) }
        self.steps = steps
        notStarted = rec.status == .pending
        canRetry = rec.status == .failed

        switch (upload, prepare, analyse) {
        case (.waiting, _, _):
            headline = "Not uploaded yet"
            note = "Upload it to watch it anywhere, share it, and get the AI analysis."
            progress = nil
        case (.failed, _, _):
            headline = "Upload paused"
            note = rec.uploadError ?? "Tap Retry — everything already uploaded is kept."
            progress = rec.progress > 0 ? rec.progress : nil
        case (.active, _, _):
            let sent = Int64(Double(rec.sizeBytes) * rec.progress)
            let of = rec.sizeBytes > 0
                ? " · \(ByteCountFormatter.string(fromByteCount: sent, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(rec.sizeBytes), countStyle: .file))"
                : ""
            headline = rec.progress >= 0.999 ? "Finishing upload…" : "Uploading · \(Int(rec.progress * 100))%\(of)"
            note = "Keeps going in the background — you can leave this screen or lock your phone."
                + (rec.analyseOnUpload != nil ? " The AI analysis starts as soon as it's up." : "")
            progress = rec.progress
        case (_, .active, _), (_, .waiting, _):
            headline = "Preparing for playback…"
            note = "Uploaded. The server is getting it ready to stream and scrub."
            progress = nil
        case (_, .failed, _):
            headline = "The server couldn't prepare this video"
            note = nil
            progress = nil
        default:
            headline = "Analysing the match…"
            note = "Rallies, shots and the 3D view appear here when it's done. This takes a few minutes."
            progress = nil
        }
    }
}

struct MatchJourneyCard: View {
    let journey: MatchJourney
    let onUpload: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 0) {
                ForEach(Array(journey.steps.enumerated()), id: \.element.id) { k, step in
                    stepView(step)
                    if k < journey.steps.count - 1 {
                        Rectangle()
                            .fill(step.state == .done ? Theme.sage : Theme.border)
                            .frame(height: 2)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 6)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(journey.headline)
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(journey.canRetry ? Theme.danger : Theme.text)
                if let note = journey.note {
                    Text(note).font(.caption).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let progress = journey.progress {
                ProgressBar(value: progress, height: 6)
                    .animation(.easeOut(duration: 0.3), value: progress)
            }

            if journey.notStarted {
                HStack(spacing: 8) {
                    actionButton("AI Analysis", "sparkles", filled: true, action: onUpload)
                    actionButton("Upload", "arrow.up.circle.fill", filled: false, action: onUpload)
                }
            } else if journey.canRetry {
                actionButton("Retry upload", "arrow.clockwise", filled: true, action: onRetry)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
    }

    private func stepView(_ step: MatchJourney.Step) -> some View {
        HStack(spacing: 6) {
            ZStack {
                Circle()
                    .fill(fill(step.state))
                    .frame(width: 20, height: 20)
                switch step.state {
                case .done:
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.bg)
                case .failed:
                    Image(systemName: "exclamationmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.text)
                case .active:
                    ProgressView().controlSize(.mini).tint(Theme.text)
                case .waiting:
                    EmptyView()
                }
            }
            Text(step.id)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(step.state == .waiting ? Theme.muted : Theme.text)
                .lineLimit(1)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.id): \(String(describing: step.state))")
    }

    private func fill(_ state: MatchJourney.StepState) -> Color {
        switch state {
        case .done: return Theme.sage
        case .active: return Theme.accent
        case .failed: return Theme.danger
        case .waiting: return Theme.surface2
        }
    }

    private func actionButton(_ title: String, _ icon: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(filled ? Theme.accent : .clear, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(filled ? .clear : Theme.border, lineWidth: 1.5))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .buttonStyle(.plain)
    }
}
