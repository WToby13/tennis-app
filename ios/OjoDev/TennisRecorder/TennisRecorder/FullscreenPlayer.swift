import AVFoundation
import SwiftUI

/// The fullscreen review surface: video edge to edge, no app chrome, and the
/// whole match legible on one bar — service games as chapters above the timeline,
/// rallies as dots below it. Nothing scrolls; everything you need is on top of the
/// picture and gets out of the way when you stop touching it.
struct FullscreenPlayer: View {
    @ObservedObject var model: PlayerModel
    /// Observed, not snapshotted, so a breakdown that finishes while you're in
    /// here fills the chapters and dots in without leaving fullscreen.
    @ObservedObject var analysis: AnalysisModel
    /// Back chevron: leaves fullscreen, or the screen entirely.
    let onExit: () -> Void

    /// Fit shows the whole court; fill uses every pixel of a taller-than-16:9
    /// screen at the cost of cropping the top and bottom of the frame. Double-tap
    /// switches, the way a video app usually does it.
    @State private var fills = false
    @State private var controlsVisible = true
    @State private var hideTask: Task<Void, Never>?

    private static let speeds: [Float] = [0.25, 0.5, 1, 1.5, 2]
    /// How long the controls stay up after you last touched something.
    private static let idleHide: Duration = .seconds(3.5)

    var body: some View {
        ZStack {
            Color.black
            PlayerLayerView(player: model.player, gravity: fills ? .resizeAspectFill : .resizeAspect)
                .ignoresSafeArea()
            // Taps land here when the controls are hidden (and between them when
            // they're not), so one tap anywhere brings them back.
            // Double-tap is declared first so it gets the chance to claim the
            // gesture; otherwise the single tap always wins and fills never fires.
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { fills.toggle() }
                .onTapGesture { controlsVisible ? hideControls() : showControls() }

            if controlsVisible {
                controls.transition(.opacity)
            }
        }
        .background(Color.black.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.2), value: controlsVisible)
        .onAppear { showControls() }
        .onDisappear { hideTask?.cancel() }
        // While paused the controls stay put — you're reading them, not watching.
        .onChange(of: model.isPlaying) { _, _ in showControls() }
    }

    // MARK: Controls

    private var controls: some View {
        ZStack {
            LinearGradient(
                colors: [.black.opacity(0.45), .clear, .black.opacity(0.6)],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)

            transport

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0)
                timeline
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button(action: onExit) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.35), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")

            Spacer()

            SpeedMenu(model: model, speeds: Self.speeds)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    /// Transport in the middle of the screen, where your thumbs already are when
    /// the phone is held in two hands.
    private var transport: some View {
        HStack(spacing: 30) {
            TransportButton(icon: "gobackward.10", size: 26) { touch { model.skip(-10) } }
            TransportButton(icon: "backward.frame.fill", size: 24) { touch { model.stepFrames(-1) } }
            Button { touch { model.togglePlay() } } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 68, height: 68)
                    .background(Theme.accent, in: Circle())
                    .shadow(color: .black.opacity(0.3), radius: 8)
            }
            .buttonStyle(.plain)
            TransportButton(icon: "forward.frame.fill", size: 24) { touch { model.stepFrames(1) } }
            TransportButton(icon: "goforward.10", size: 26) { touch { model.skip(10) } }
        }
    }

    /// Chapters, timeline and rallies share one width and one time scale, stacked
    /// so a game bar sits directly over the moment it covers.
    private var timeline: some View {
        VStack(spacing: 5) {
            if !analysis.games.isEmpty {
                ChapterBar(games: analysis.games, total: total) { seconds in
                    touch { model.play(from: seconds) }
                }
            }
            ScrubBar(model: model)
            if !analysis.segments.isEmpty {
                RallyDots(segments: analysis.segments, total: total)
            }
            HStack {
                Text(PlayerModel.timeLabel(model.currentTime))
                Spacer()
                Text(PlayerModel.timeLabel(model.duration))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.white.opacity(0.8))
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    /// The span the chapter/rally rows map onto — the timeline's own scale, so
    /// they stay aligned with the scrubber even if the analysis overruns.
    private var total: Double {
        max(model.duration, analysis.segments.reduce(0) { max($0, $1.endS ?? 0) }, 1)
    }

    // MARK: Auto-hide

    /// Run a control's action and keep the controls up — using them shouldn't
    /// start the clock that takes them away.
    private func touch(_ action: () -> Void) {
        action()
        showControls()
    }

    private func showControls() {
        controlsVisible = true
        hideTask?.cancel()
        guard model.isPlaying else { return }
        hideTask = Task {
            try? await Task.sleep(for: Self.idleHide)
            guard !Task.isCancelled else { return }
            controlsVisible = false
        }
    }

    private func hideControls() {
        hideTask?.cancel()
        controlsVisible = false
    }
}

/// Service games as chapter bars — one segment per game, coloured by who served,
/// laid out across the match the way YouTube lays out chapters. Tap to jump.
private struct ChapterBar: View {
    let games: [ServiceGame]
    let total: Double
    let onSeek: (Double) -> Void

    /// Trimmed off each bar's right edge so neighbouring games read as separate.
    private static let gap: CGFloat = 2

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                ForEach(games) { game in
                    let x = geo.size.width * fraction(game.startS)
                    let w = geo.size.width * (fraction(game.endS) - fraction(game.startS))
                    Capsule()
                        .fill(color(game.server))
                        .frame(width: max(3, w - Self.gap), height: 5)
                        .offset(x: x)
                        .contentShape(Rectangle())
                        .onTapGesture { onSeek(game.startS) }
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 10)
    }

    private func fraction(_ seconds: Double) -> CGFloat {
        CGFloat(min(max(seconds / total, 0), 1))
    }

    private func color(_ server: String?) -> Color {
        switch server {
        case "player_1": return Theme.accent.opacity(0.95)
        case "player_2": return Theme.sage.opacity(0.95)
        default: return .white.opacity(0.5)
        }
    }
}

/// Rallies as dots under the timeline — the texture of the match at a glance:
/// where the long exchanges were and where play thinned out. Decorative: at a
/// couple of hundred rallies they sit closer together than a fingertip, so the
/// timeline above is what you actually seek with.
private struct RallyDots: View {
    let segments: [AnalysisSegment]
    let total: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                ForEach(segments) { segment in
                    Circle()
                        .fill(.white.opacity(0.55))
                        .frame(width: 4, height: 4)
                        .offset(x: geo.size.width * fraction(segment.startS ?? 0) - 2)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 6)
        .allowsHitTesting(false)
    }

    private func fraction(_ seconds: Double) -> CGFloat {
        CGFloat(min(max(seconds / total, 0), 1))
    }
}
