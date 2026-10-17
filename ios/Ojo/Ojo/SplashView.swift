import SwiftUI

/// The two seconds between tapping the icon and the app: a clay court draws
/// itself in chalk, a ball is struck from the near baseline, clears the net and
/// bounces deep in the far court — and where it lands, Ojo opens its eye.
///
/// Driven by one clock (`TimelineView`) rather than a chain of `withAnimation`
/// calls, so every element is a pure function of time and the sequence can't
/// drift out of step with itself on a slow first frame.
struct SplashView: View {
    /// How long the full sequence runs. The root holds the splash at least this
    /// long, and longer only if the session check is still going.
    static let duration: Double = 2.0

    @State private var start = Date()

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSince(start)
            GeometryReader { geo in
                let size = geo.size
                ZStack {
                    Theme.bg.ignoresSafeArea()
                    glow(t, size)
                    court(t, size)
                    ball(t, size)
                    logo(t, size)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ojo Tennis")
    }

    // MARK: Geometry

    /// The court as seen from behind the near baseline, in a gentle perspective:
    /// a trapezoid narrowing towards the far end. Points are in court metres
    /// (x across, y from the near baseline toward the far one) mapped to screen.
    private struct Court {
        let size: CGSize
        var nearY: CGFloat { size.height * 0.80 }
        var farY: CGFloat { size.height * 0.30 }
        var nearHalf: CGFloat { min(size.width * 0.46, 210) }
        var farHalf: CGFloat { nearHalf * 0.46 }

        /// x in [-5.485, 5.485] (doubles), y in [0, 23.77] → screen.
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            let f = y / 23.77
            // Ease the depth so the far half is foreshortened, like a real lens.
            let d = 1 - pow(1 - f, 1.35)
            let half = nearHalf + (farHalf - nearHalf) * d
            let sy = nearY + (farY - nearY) * d
            return CGPoint(x: size.width / 2 + half * x / 5.485, y: sy)
        }
    }

    private func court(_ t: Double, _ size: CGSize) -> some View {
        let c = Court(size: size)
        let draw = ease(clamp((t - 0.0) / 0.75))
        let fade = 1 - 0.55 * ease(clamp((t - 1.2) / 0.6))
        let lines: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (-5.485, 0, 5.485, 0), (-5.485, 23.77, 5.485, 23.77),
            (-5.485, 0, -5.485, 23.77), (5.485, 0, 5.485, 23.77),
            (-4.115, 0, -4.115, 23.77), (4.115, 0, 4.115, 23.77),
            (-4.115, 5.485, 4.115, 5.485), (-4.115, 18.285, 4.115, 18.285),
            (0, 5.485, 0, 18.285),
        ]
        return ZStack {
            // The clay inside the lines, warming up as the chalk goes down.
            Path { p in
                p.move(to: c.point(-5.485, 0))
                p.addLine(to: c.point(5.485, 0))
                p.addLine(to: c.point(5.485, 23.77))
                p.addLine(to: c.point(-5.485, 23.77))
                p.closeSubpath()
            }
            .fill(Theme.accent.opacity(0.10 * draw))

            Path { p in
                for (x1, y1, x2, y2) in lines {
                    p.move(to: c.point(x1, y1))
                    p.addLine(to: c.point(x2, y2))
                }
            }
            .trim(from: 0, to: draw)
            .stroke(Theme.text.opacity(0.32), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))

            // The net: a brighter band across the middle.
            Path { p in
                p.move(to: c.point(-6.4, 11.885))
                p.addLine(to: c.point(6.4, 11.885))
            }
            .trim(from: 0, to: ease(clamp((t - 0.25) / 0.5)))
            .stroke(Theme.text.opacity(0.55), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
        .opacity(fade)
    }

    // MARK: Ball

    /// Struck at 0.30 s from behind the near baseline, bounces at 1.05 s deep in
    /// the far court, and rises into the logo.
    private static let strike = 0.30
    private static let bounce = 1.05

    private func ballState(_ t: Double, _ c: Court) -> (pos: CGPoint, ground: CGPoint, height: CGFloat)? {
        guard t >= Self.strike else { return nil }
        let from = (x: CGFloat(-2.2), y: CGFloat(-0.6))
        let to = (x: CGFloat(1.1), y: CGFloat(19.6))
        if t <= Self.bounce {
            let f = CGFloat((t - Self.strike) / (Self.bounce - Self.strike))
            let x = from.x + (to.x - from.x) * f
            let y = from.y + (to.y - from.y) * f
            let ground = c.point(x, y)
            // Height in screen points: a parabola that clears the net comfortably.
            let h = (1 - f) * 0.35 * c.nearHalf * 0.5 + 4 * f * (1 - f) * c.size.height * 0.20
            return (CGPoint(x: ground.x, y: ground.y - h), ground, h)
        }
        return nil
    }

    private func ball(_ t: Double, _ size: CGSize) -> some View {
        let c = Court(size: size)
        let land = c.point(1.1, 19.6)
        return ZStack {
            if let s = ballState(t, c) {
                // Shadow on the court, shrinking as the ball climbs.
                Ellipse()
                    .fill(.black.opacity(0.35))
                    .frame(width: 12 - min(6, s.height / 30), height: 4)
                    .position(s.ground)
                // A short comet tail along the flight.
                ForEach(1..<7) { k in
                    if let p = ballState(t - Double(k) * 0.022, c) {
                        Circle()
                            .fill(Self.ballColor.opacity(0.28 - Double(k) * 0.04))
                            .frame(width: 11 - CGFloat(k), height: 11 - CGFloat(k))
                            .position(p.pos)
                    }
                }
                Circle()
                    .fill(Self.ballColor)
                    .frame(width: 12, height: 12)
                    .shadow(color: Self.ballColor.opacity(0.6), radius: 6)
                    .position(s.pos)
            }
            // The bounce mark: two rings rippling out from where it landed.
            if t >= Self.bounce {
                let k = clamp((t - Self.bounce) / 0.7)
                ForEach(0..<2) { i in
                    let ki = clamp(k - Double(i) * 0.18)
                    Ellipse()
                        .stroke(Theme.sage.opacity(0.8 * (1 - ki)), lineWidth: 2)
                        .frame(width: 14 + 70 * ki, height: 5 + 24 * ki)
                        .position(land)
                }
            }
        }
    }

    private static let ballColor = Color(hex: 0xE8F24A)

    // MARK: Logo

    private func logo(_ t: Double, _ size: CGSize) -> some View {
        let pop = clamp((t - Self.bounce + 0.05) / 0.55)
        let scale = 0.35 + 0.65 * springy(pop)
        let word = ease(clamp((t - 1.3) / 0.45))
        return VStack(spacing: 18) {
            Image("OjoLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .shadow(color: Theme.accent.opacity(0.45 * pop), radius: 24)
                .scaleEffect(scale)
                .opacity(min(1, pop * 3))
            Text("OJO TENNIS")
                .font(.system(size: 15, weight: .semibold))
                .tracking(6)
                .foregroundStyle(Theme.text)
                .opacity(word)
                .offset(y: 10 * (1 - word))
        }
        .position(x: size.width / 2, y: size.height * 0.44)
    }

    /// A warm bloom behind the logo as it opens.
    private func glow(_ t: Double, _ size: CGSize) -> some View {
        let k = ease(clamp((t - Self.bounce) / 0.6))
        return RadialGradient(
            colors: [Theme.accent.opacity(0.22 * k), .clear],
            center: UnitPoint(x: 0.5, y: 0.44),
            startRadius: 0,
            endRadius: max(size.width, 1) * 0.75
        )
        .ignoresSafeArea()
    }

    // MARK: Easing

    private func clamp(_ v: Double) -> Double { min(max(v, 0), 1) }
    private func ease(_ v: Double) -> Double { 1 - pow(1 - v, 3) }
    /// Overshoots a little and settles — the pop of the logo.
    private func springy(_ v: Double) -> Double {
        guard v > 0 else { return 0 }
        return 1 - exp(-6 * v) * cos(9 * v)
    }
}

#Preview {
    SplashView().preferredColorScheme(.dark)
}
