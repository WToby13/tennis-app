import AVFoundation
import Combine
import SwiftUI
import UIKit

/// Drives an AVPlayer for match review, exposing the state the custom controls
/// need (playing, current time, duration, rate) and the review actions
/// (play/pause, playback speed, single-frame stepping, skip). All mutations
/// happen on the main thread (the time observer uses the main queue and the
/// controls call in from SwiftUI).
final class PlayerModel: ObservableObject {
    let player: AVPlayer
    @Published var isPlaying = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var rate: Float = 1.0
    /// True while the user is dragging the scrubber, so the time observer doesn't
    /// fight the slider.
    var scrubbing = false

    /// Assumed frame rate for single-frame stepping (matches the web review page).
    private let fps: Double = 30
    private var timeObserver: Any?

    init(url: URL) {
        player = AVPlayer(url: url)
        player.actionAtItemEnd = .pause
        let interval = CMTime(seconds: 0.03, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self, !self.scrubbing else { return }
            self.currentTime = time.seconds
            if let dur = self.player.currentItem?.duration.seconds, dur.isFinite {
                self.duration = dur
            }
            self.isPlaying = self.player.timeControlStatus == .playing
        }
    }

    deinit {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
    }

    func togglePlay() {
        if player.timeControlStatus == .playing {
            player.pause()
            isPlaying = false
        } else {
            player.playImmediately(atRate: rate)
            isPlaying = true
        }
    }

    func setRate(_ newRate: Float) {
        rate = newRate
        if player.timeControlStatus == .playing {
            player.rate = newRate
        }
    }

    /// Step exactly one frame forward/back. Pauses first, then seeks with zero
    /// tolerance so the seek lands on the requested frame.
    func stepFrames(_ frames: Int) {
        player.pause()
        isPlaying = false
        let target = max(0, min(duration, currentTime + Double(frames) / fps))
        seek(to: target)
    }

    /// Skip forward/back by whole seconds.
    func skip(_ seconds: Double) {
        let target = max(0, min(duration, currentTime + seconds))
        seek(to: target)
    }

    func seek(to seconds: Double) {
        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        currentTime = seconds
    }

    func pause() {
        player.pause()
        isPlaying = false
    }

    /// Jump to a point in the match and start playing from there — used when a
    /// rally in the AI breakdown is tapped.
    func play(from seconds: Double) {
        seek(to: max(0, seconds))
        player.playImmediately(atRate: rate)
        isPlaying = true
    }
}

/// AVPlayerLayer wrapped for SwiftUI — the raw video surface, no system controls
/// (we draw our own so slow-mo / frame-step match the web review tools).
private struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        uiView.playerLayer.player = player
    }

    final class PlayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// The match review surface: the video plus a custom control bar with play/pause,
/// playback speed, single-frame stepping, ±5/±10s skip and a scrubber.
/// The model is owned by the presenting screen (not this view) so siblings — the
/// AI breakdown in particular — can seek the same player.
struct ReviewPlayer: View {
    @ObservedObject var model: PlayerModel
    /// Whether the presenting screen is already in fullscreen review — landscape
    /// gets there on its own, so the button then only offers the way out.
    var isFullscreen = false
    var onToggleFullscreen: (() -> Void)?

    private static let speeds: [Float] = [0.25, 0.5, 1, 1.5, 2]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black
            PlayerLayerView(player: model.player)
            controls
        }
        .onDisappear { model.pause() }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            // Scrubber + times
            HStack(spacing: 10) {
                Text(timeLabel(model.currentTime)).font(.caption.monospacedDigit()).foregroundStyle(.white)
                Slider(
                    value: Binding(
                        get: { model.currentTime },
                        set: { model.currentTime = $0 }
                    ),
                    in: 0...max(model.duration, 0.01),
                    onEditingChanged: { editing in
                        model.scrubbing = editing
                        if !editing { model.seek(to: model.currentTime) }
                    }
                )
                .tint(Theme.accent)
                Text(timeLabel(model.duration)).font(.caption.monospacedDigit()).foregroundStyle(.white.opacity(0.7))
            }

            // Transport
            HStack(spacing: 18) {
                transportButton("gobackward.10") { model.skip(-10) }
                transportButton("backward.frame.fill") { model.stepFrames(-1) }
                Button(action: { model.togglePlay() }) {
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Theme.accent, in: Circle())
                }
                transportButton("forward.frame.fill") { model.stepFrames(1) }
                transportButton("goforward.10") { model.skip(10) }

                Spacer()

                speedMenu
                if let onToggleFullscreen {
                    transportButton(isFullscreen
                                    ? "arrow.down.right.and.arrow.up.left"
                                    : "arrow.up.left.and.arrow.down.right",
                                    action: onToggleFullscreen)
                        .accessibilityLabel(isFullscreen ? "Exit fullscreen" : "Fullscreen")
                }
            }
        }
        .padding(14)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom)
        )
    }

    private func transportButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }

    private var speedMenu: some View {
        Menu {
            ForEach(Self.speeds, id: \.self) { speed in
                Button {
                    model.setRate(speed)
                } label: {
                    Label(speedLabel(speed), systemImage: model.rate == speed ? "checkmark" : "")
                }
            }
        } label: {
            Text(speedLabel(model.rate))
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(.white.opacity(0.18), in: Capsule())
        }
    }

    private func speedLabel(_ rate: Float) -> String {
        rate == rate.rounded() ? "\(Int(rate))×" : "\(rate)×"
    }

    private func timeLabel(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
