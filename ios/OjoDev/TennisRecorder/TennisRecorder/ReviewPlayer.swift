import AVFoundation
import Combine
import SwiftUI
import UIKit

/// Drives an AVPlayer for match review, exposing the state the custom controls
/// need (playing, current time, duration, rate) and the review actions
/// (play/pause, playback speed, single-frame stepping, skip).
///
/// Playback state and duration are *observed from the player* rather than
/// assumed at the call site. Setting them optimistically is what left the clock
/// reading 0:00 over rolling video: `play()` on an item that wasn't ready yet
/// only queues playback, and a remote item reports an indefinite duration until
/// its asset loads.
final class PlayerModel: ObservableObject {
    let player: AVPlayer
    @Published var isPlaying = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var rate: Float = 1.0
    /// True while the user is dragging the scrubber, so the time observer doesn't
    /// fight the drag.
    var scrubbing = false

    /// Assumed frame rate for single-frame stepping (matches the web review page).
    private let fps: Double = 30
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []

    /// `knownDuration` seeds the timeline from metadata we already hold, so the
    /// scrubber is usable on the first frame instead of after the asset loads.
    init(url: URL, knownDuration: Double = 0) {
        let item = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: item)
        player.actionAtItemEnd = .pause
        if knownDuration.isFinite, knownDuration > 0 { duration = knownDuration }

        let interval = CMTime(seconds: 0.05, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self, !self.scrubbing else { return }
            let seconds = time.seconds
            if seconds.isFinite { self.currentTime = seconds }
        }

        // The player's own view of whether frames are moving — covers the gap
        // between asking it to play and it actually starting (buffering, a seek
        // still in flight, an item that wasn't ready).
        player.publisher(for: \.timeControlStatus)
            .map { $0 == .playing }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] playing in self?.isPlaying = playing }
            .store(in: &cancellables)

        // Duration arrives late for a streamed item, and can be reported again if
        // the item is replaced; take it whenever it becomes a real number.
        item.publisher(for: \.duration)
            .map(\.seconds)
            .filter { $0.isFinite && $0 > 0 }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] seconds in self?.duration = seconds }
            .store(in: &cancellables)
    }

    deinit {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
    }

    func togglePlay() {
        if player.timeControlStatus == .playing {
            player.pause()
        } else {
            player.playImmediately(atRate: rate)
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
        let target = max(0, min(durationOrCurrent, currentTime + Double(frames) / fps))
        seek(to: target)
    }

    /// Skip forward/back by whole seconds.
    func skip(_ seconds: Double) {
        seek(to: max(0, min(durationOrCurrent, currentTime + seconds)))
    }

    func seek(to seconds: Double) {
        guard seconds.isFinite else { return }
        let target = max(0, seconds)
        currentTime = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func pause() {
        player.pause()
    }

    /// Jump to a point in the match and start playing from there — used when a
    /// rally or service game is tapped.
    func play(from seconds: Double) {
        seek(to: seconds)
        player.playImmediately(atRate: rate)
    }

    /// Clamp target for seeks before the real duration is known.
    private var durationOrCurrent: Double {
        duration > 0 ? duration : max(currentTime, 0)
    }

    /// m:ss for any of the time labels.
    static func timeLabel(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// AVPlayerLayer wrapped for SwiftUI — the raw video surface, no system controls
/// (we draw our own so slow-mo / frame-step match the web review tools).
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    var gravity: AVLayerVideoGravity = .resizeAspect

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = gravity
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        if uiView.playerLayer.player !== player { uiView.playerLayer.player = player }
        if uiView.playerLayer.videoGravity != gravity { uiView.playerLayer.videoGravity = gravity }
    }

    final class PlayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// The match timeline: a track you can press or drag anywhere on.
///
/// Custom rather than a `Slider` because the fullscreen player stacks service-game
/// chapters above it and rally dots below, and those only line up if every row
/// maps time onto the *same* width — a Slider reserves invisible room for its
/// thumb, which would offset it from anything drawn alongside.
struct ScrubBar: View {
    @ObservedObject var model: PlayerModel
    var trackHeight: CGFloat = 4
    var thumbSize: CGFloat = 12

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let fraction = model.duration > 0
                ? min(max(model.currentTime / model.duration, 0), 1)
                : 0
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.25))
                    .frame(height: trackHeight)
                Capsule().fill(Theme.accent)
                    .frame(width: width * fraction, height: trackHeight)
                Circle().fill(.white)
                    .frame(width: thumbSize, height: thumbSize)
                    .offset(x: width * fraction - thumbSize / 2)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                // minimumDistance 0 so a tap anywhere on the track seeks there.
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        model.scrubbing = true
                        model.currentTime = time(at: value.location.x, width: width)
                    }
                    .onEnded { value in
                        let target = time(at: value.location.x, width: width)
                        model.scrubbing = false
                        model.seek(to: target)
                    }
            )
        }
        .frame(height: max(thumbSize, trackHeight))
    }

    private func time(at x: CGFloat, width: CGFloat) -> Double {
        guard width > 0, model.duration > 0 else { return 0 }
        return min(max(Double(x / width), 0), 1) * model.duration
    }
}

/// The in-page review surface: the video plus a control bar with play/pause,
/// playback speed, single-frame stepping, ±10s skip and the scrubber. The model is
/// owned by the presenting screen (not this view) so siblings — the AI breakdown
/// in particular — can seek the same player.
struct ReviewPlayer: View {
    @ObservedObject var model: PlayerModel
    var onEnterFullscreen: (() -> Void)?

    private static let speeds: [Float] = [0.25, 0.5, 1, 1.5, 2]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black
            PlayerLayerView(player: model.player)
            controls
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Text(PlayerModel.timeLabel(model.currentTime))
                    .font(.caption.monospacedDigit()).foregroundStyle(.white)
                ScrubBar(model: model)
                Text(PlayerModel.timeLabel(model.duration))
                    .font(.caption.monospacedDigit()).foregroundStyle(.white.opacity(0.7))
            }

            HStack(spacing: 18) {
                TransportButton(icon: "gobackward.10") { model.skip(-10) }
                TransportButton(icon: "backward.frame.fill") { model.stepFrames(-1) }
                Button(action: { model.togglePlay() }) {
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Theme.accent, in: Circle())
                }
                TransportButton(icon: "forward.frame.fill") { model.stepFrames(1) }
                TransportButton(icon: "goforward.10") { model.skip(10) }

                Spacer()

                SpeedMenu(model: model, speeds: Self.speeds)
                if let onEnterFullscreen {
                    TransportButton(icon: "arrow.up.left.and.arrow.down.right",
                                    action: onEnterFullscreen)
                        .accessibilityLabel("Fullscreen")
                }
            }
        }
        .padding(14)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom)
        )
    }
}

/// A plain white glyph button — the shared look for every transport control, in
/// the page player and the fullscreen one.
struct TransportButton: View {
    let icon: String
    var size: CGFloat = 22
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(.white)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct SpeedMenu: View {
    @ObservedObject var model: PlayerModel
    let speeds: [Float]

    var body: some View {
        Menu {
            ForEach(speeds, id: \.self) { speed in
                Button {
                    model.setRate(speed)
                } label: {
                    Label(Self.label(speed), systemImage: model.rate == speed ? "checkmark" : "")
                }
            }
        } label: {
            Text(Self.label(model.rate))
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(.white.opacity(0.18), in: Capsule())
        }
    }

    static func label(_ rate: Float) -> String {
        rate == rate.rounded() ? "\(Int(rate))×" : "\(rate)×"
    }
}
