import AVFoundation
import SwiftUI

/// Our tracking drawn over the playing video (web/app/TrackOverlay.tsx): the
/// ball and a short trail, each player boxed in their colour, and each bounce
/// with its speed for a moment after it lands. Sits over the player layer,
/// follows its picture (letterboxing included), and reads the time straight
/// from the player every display frame, so it stays on the ball at any speed.
struct TrackOverlayView: View {
    let tracks: MatchTracks
    let player: AVPlayer
    /// How the video is fitted under the overlay — fill crops, so the overlay
    /// has to crop the same way.
    var fills = false

    private static let trail = 12 // frames
    private static let bounceHold = 2.2 // seconds
    private static let ballColor = Color(hex: 0xFFE14D)

    var body: some View {
        // The tick has to reach the Canvas. The time comes from the player, not
        // the timeline, so a closure that ignores `context.date` looks identical
        // on every tick and SwiftUI keeps the old drawing — the overlay only
        // moved when something else (a rotation, a layout) forced a redraw.
        TimelineView(.animation) { context in
            Canvas { g, size in draw(g, size, at: context.date) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(_ g: GraphicsContext, _ size: CGSize, at _: Date) {
        let s = fills
            ? max(size.width / tracks.width, size.height / tracks.height)
            : min(size.width / tracks.width, size.height / tracks.height)
        let ox = (size.width - tracks.width * s) / 2, oy = (size.height - tracks.height * s) / 2
        let X = { (u: Double) in ox + u * s }, Y = { (v: Double) in oy + v * s }
        let t = player.currentTime().seconds
        guard t.isFinite else { return }
        let f = Int((t * tracks.fps).rounded())

        // Players: the nearest detection within a few frames (they were sampled).
        let P = tracks.players
        var k = floorIndex(P.f, f)
        var bySide: [String: Int] = [:]
        if !P.f.isEmpty {
            for j in max(0, k - 3)...min(P.f.count - 1, max(0, k + 4)) where abs(P.f[j] - f) <= 4 {
                if let prev = bySide[P.side[j]], abs(P.f[prev] - f) <= abs(P.f[j] - f) { continue }
                bySide[P.side[j]] = j
            }
        }
        for j in bySide.values {
            let box = P.box[j]
            guard box.count == 4 else { continue }
            let c = PlayerColor.of(P.who[j].isEmpty ? nil : P.who[j])
            let rect = CGRect(x: X(box[0]), y: Y(box[1]), width: (box[2] - box[0]) * s, height: (box[3] - box[1]) * s)
            g.stroke(Path(rect), with: .color(c), lineWidth: 1.5)
            if !P.who[j].isEmpty {
                g.draw(Text(P.who[j]).font(.system(size: 11, weight: .bold)).foregroundColor(c),
                       at: CGPoint(x: rect.minX, y: rect.minY - 3), anchor: .bottomLeading)
            }
        }

        // Ball and trail.
        let B = tracks.ball
        k = floorIndex(B.f, f)
        if k >= 0 {
            for j in max(0, k - Self.trail)...k where f - B.f[j] <= Self.trail {
                let c = CGPoint(x: X(B.u[j]), y: Y(B.v[j]))
                if B.f[j] == f {
                    g.stroke(Path(ellipseIn: CGRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10)),
                             with: .color(Self.ballColor), lineWidth: 2)
                } else {
                    let a = 0.35 + 0.5 * Double(Self.trail - (f - B.f[j])) / Double(Self.trail)
                    g.fill(Path(ellipseIn: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4)),
                           with: .color(Self.ballColor.opacity(a)))
                }
            }
        }

        // The latest bounce, for a moment after it lands.
        let bi = floorIndex(tracks.bounces, t) { $0.t }
        if bi >= 0, t - tracks.bounces[bi].t < Self.bounceHold {
            let b = tracks.bounces[bi]
            let c = CallColor.of(b.landing)
            let at = CGPoint(x: X(b.u), y: Y(b.v))
            g.stroke(Path(ellipseIn: CGRect(x: at.x - 12, y: at.y - 5, width: 24, height: 10)), with: .color(c), lineWidth: 2)
            var label = "\(Int(b.speed.rounded())) km/h"
            if let l = b.landing, l != "net" { label += " · \(l)" }
            let text = g.resolve(Text(label).font(.system(size: 11, weight: .semibold)).foregroundColor(c))
            let sz = text.measure(in: CGSize(width: 200, height: 30))
            let bg = CGRect(x: at.x + 14, y: at.y - sz.height / 2 - 3, width: sz.width + 10, height: sz.height + 6)
            g.fill(Path(roundedRect: bg, cornerRadius: 4), with: .color(Color(hex: 0x0F0C09).opacity(0.75)))
            g.draw(text, at: CGPoint(x: bg.minX + 5, y: at.y), anchor: .leading)
        }
    }
}

/// Index of the last element whose key is <= x in a sorted array, or -1.
func floorIndex<T>(_ arr: [T], _ x: Double, key: (T) -> Double) -> Int {
    var lo = 0, hi = arr.count - 1, ans = -1
    while lo <= hi {
        let mid = (lo + hi) / 2
        if key(arr[mid]) <= x { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}

/// Index of the last element <= x in a sorted array, or -1.
func floorIndex<T: Comparable>(_ arr: [T], _ x: T) -> Int {
    var lo = 0, hi = arr.count - 1, ans = -1
    while lo <= hi {
        let mid = (lo + hi) / 2
        if arr[mid] <= x { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}
