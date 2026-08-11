import Combine
import SwiftUI

/// One service game: a run of consecutive rallies sharing a `game` number, as
/// stamped by the structural smoother. Mirrors `buildServiceGames` on the web.
struct ServiceGame: Identifiable {
    let id = UUID()
    let game: Int
    let server: String?
    let startS: Double
    var endS: Double
    var points: Int

    /// Group rallies into service games: consecutive points sharing a `game`
    /// number become one bar, labelled with that game's server.
    static func build(from segments: [AnalysisSegment]) -> [ServiceGame] {
        var out: [ServiceGame] = []
        for s in segments {
            let start = s.startS ?? 0
            let end = s.endS ?? start
            let g = s.metadata?.game.map { Int($0) }
            if var last = out.last, let g, last.game == g {
                last.endS = max(last.endS, end)
                last.points += 1
                out[out.count - 1] = last
            } else {
                out.append(ServiceGame(game: g ?? out.count + 1, server: s.metadata?.server,
                                       startS: start, endS: end, points: 1))
            }
        }
        return out
    }
}

/// The match's shape at a glance: two lanes spanning the full recording — service
/// games above, raw rallies below — with every bar placed and sized by when it
/// actually happened. The iOS counterpart of the web timeline in `RallySegments`,
/// and the thing worth looking at in landscape, where the video is the page and
/// this is what you scroll to.
///
/// Tapping any bar seeks the player; the playhead tracks it back.
struct RallyTimeline: View {
    let segments: [AnalysisSegment]
    let games: [ServiceGame]
    /// Resolves the model's `player_1` / `player_2` to display names.
    let nameOf: (String?) -> String
    /// The recording's length, so bars are positioned against the real match and
    /// not just the span the model happened to return.
    let durationS: Double
    /// The player to track with the playhead. Nil hides it.
    var player: PlayerModel?
    let onSeek: (Double) -> Void

    /// The playhead's own copy of the time, stepped coarsely: the player reports
    /// ~33 times a second and redrawing every bar that often is wasted work for a
    /// marker that moves a fraction of a pixel.
    @State private var playhead: Double?
    private static let playheadStep: Double = 0.25

    private static let gameLaneHeight: CGFloat = 30
    private static let rallyLaneHeight: CGFloat = 16
    /// Bars never render thinner than this, or a 4-second rally in a two-hour
    /// match would be a sub-pixel sliver nobody can see or hit.
    private static let minBarWidth: CGFloat = 3

    /// The span the lanes map onto: the recording's length, or the last rally's
    /// end if the analysis somehow runs past it.
    private var total: Double {
        max(durationS, segments.reduce(0) { max($0, $1.endS ?? 0) }, 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            legend
            lane(label: "SERVICE GAMES", height: Self.gameLaneHeight) { width in
                ForEach(games) { game in
                    bar(from: game.startS, to: game.endS, width: width,
                        height: Self.gameLaneHeight,
                        fill: serverColor(game.server).opacity(0.85),
                        label: nameOf(game.server))
                        .onTapGesture { onSeek(game.startS) }
                }
            }
            lane(label: "RALLIES", height: Self.rallyLaneHeight) { width in
                ForEach(segments) { segment in
                    let start = segment.startS ?? 0
                    bar(from: start, to: segment.endS ?? start, width: width,
                        height: Self.rallyLaneHeight,
                        fill: serverColor(segment.metadata?.server).opacity(0.7),
                        label: nil)
                        .onTapGesture { onSeek(start) }
                }
            }
            axis
        }
        .onReceive(playerTime) { time in
            if abs((playhead ?? -1) - time) > Self.playheadStep { playhead = time }
        }
    }

    private var playerTime: AnyPublisher<Double, Never> {
        player.map { $0.$currentTime.eraseToAnyPublisher() }
            ?? Empty<Double, Never>().eraseToAnyPublisher()
    }

    // MARK: Lanes

    /// A lane is a fixed-height track the bars are absolutely positioned in, so
    /// both rows share one coordinate space and line up with the axis below.
    private func lane<Bars: View>(label: String, height: CGFloat,
                                  @ViewBuilder bars: @escaping (CGFloat) -> Bars) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 10, weight: .semibold)).tracking(0.5)
                .foregroundStyle(Theme.muted)
            GeometryReader { geo in
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Theme.surface2)
                        .frame(height: height)
                    bars(geo.size.width)
                    playheadMarker(width: geo.size.width, height: height)
                }
            }
            .frame(height: height)
        }
    }

    private func bar(from start: Double, to end: Double, width: CGFloat, height: CGFloat,
                     fill: Color, label: String?) -> some View {
        let x = width * CGFloat(min(max(start / total, 0), 1))
        let w = max(Self.minBarWidth, width * CGFloat(min(max((end - start) / total, 0), 1)))
        return RoundedRectangle(cornerRadius: 3)
            .fill(fill)
            .frame(width: min(w, max(width - x, Self.minBarWidth)), height: height)
            .overlay(alignment: .leading) {
                // Only label a bar with room for it — a squeezed name reads as noise.
                if let label, w > 52 {
                    Text(label)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.bg)
                        .lineLimit(1)
                        .padding(.leading, 5)
                }
            }
            .offset(x: x)
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private func playheadMarker(width: CGFloat, height: CGFloat) -> some View {
        if let playhead, playhead.isFinite {
            Rectangle()
                .fill(Theme.text)
                .frame(width: 1.5, height: height)
                .offset(x: width * CGFloat(min(max(playhead / total, 0), 1)))
        }
    }

    // MARK: Legend + axis

    private var legend: some View {
        HStack(spacing: 14) {
            ForEach(["player_1", "player_2"], id: \.self) { slot in
                HStack(spacing: 6) {
                    Circle().fill(serverColor(slot)).frame(width: 8, height: 8)
                    Text(nameOf(slot)).font(.caption).foregroundStyle(Theme.text)
                    Text("· \(serveCount(slot)) service \(serveCount(slot) == 1 ? "game" : "games")")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer()
        }
    }

    private var axis: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(ticks, id: \.self) { tick in
                    Text(timeLabel(tick))
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(Theme.muted)
                        .fixedSize()
                        .offset(x: geo.size.width * CGFloat(tick / total) - 12)
                }
            }
        }
        .frame(height: 12)
    }

    /// Tick spacing: 2 / 5 / 10 min for real matches, finer only for short clips.
    private var ticks: [Double] {
        let step: Double = total <= 240 ? 30 : total <= 1440 ? 120 : total <= 3600 ? 300 : 600
        return stride(from: step, to: total, by: step).map { $0 }
    }

    private func serveCount(_ slot: String) -> Int {
        games.filter { $0.server == slot }.count
    }

    private func serverColor(_ server: String?) -> Color {
        switch server {
        case "player_1": return Theme.accent
        case "player_2": return Theme.sage
        default: return Theme.muted
        }
    }

    private func timeLabel(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
