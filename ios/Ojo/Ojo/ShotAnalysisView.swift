import SwiftUI

/// Our own analysis of the match, under the video — the iOS form of the web's
/// "Shot analysis" section (web/app/MatchStats.tsx):
///
/// - the two players head to head: serve and rally speeds, how many landed in,
///   into the net, first serves, how far they ran;
/// - shot placement: where each shot was struck (left) and where it bounced
///   (right), the hitter always on the left playing to the right — tap one to
///   join the two, then play it;
/// - court position and zones: where they stood during points, and how their
///   shots from each of nine zones went;
/// - the best rallies, drawn on a court, and the service games.
struct ShotAnalysisView: View {
    let stats: MatchStats
    let onSeek: (Double) -> Void

    private var byPerson: Bool { stats.people?["A"] != nil && stats.people?["B"] != nil }

    /// The two "players" the numbers are about: A and B by kit when the analysis
    /// could tell them apart, otherwise the two ends of the court.
    private var players: [(key: String, label: String)] {
        byPerson ? [("A", "Player A"), ("B", "Player B")] : [("near", "Camera end"), ("far", "Far end")]
    }

    private func playerOf(_ s: StatsShot) -> String? { byPerson ? s.player : s.hitter }
    private func name(_ key: String?) -> String { players.first { $0.key == key }?.label ?? "Unknown" }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            HeadToHead(stats: stats, byPerson: byPerson, players: players)
            PlacementBlock(stats: stats, players: players, playerOf: playerOf, name: name, onSeek: onSeek)
            PositionBlock(stats: stats, players: players, playerOf: playerOf)
            BestRalliesBlock(stats: stats, byPerson: byPerson, playerOf: playerOf, name: name, onSeek: onSeek)
            if let games = stats.games, !games.isEmpty {
                ServiceGamesStrip(games: games, onSeek: onSeek)
            }
        }
        .padding(.horizontal, 16)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Shot analysis").font(.headline).foregroundStyle(Theme.text)
            BetaTag()
            Spacer()
            Text("\(Int(stats.points ?? Double(stats.rallies.count))) points · \(Int(stats.hits ?? Double(stats.shots.count))) shots")
                .font(.caption.weight(.medium)).foregroundStyle(Theme.muted)
        }
    }
}

struct BetaTag: View {
    var body: some View {
        Text("BETA")
            .font(.caption2.weight(.bold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(Capsule().stroke(Theme.accent.opacity(0.6), lineWidth: 1))
    }
}

// MARK: - Head to head

/// Both players' numbers on one card, each row read across: A's value, what it
/// is, B's value, and a bar splitting the two — the shape of the match at a
/// glance, which two separate cards on a narrow screen never gave.
private struct HeadToHead: View {
    let stats: MatchStats
    let byPerson: Bool
    let players: [(key: String, label: String)]

    private var a: PlayerStats { byPerson ? stats.people!["A"]! : stats.near }
    private var b: PlayerStats { byPerson ? stats.people!["B"]! : stats.far }

    private struct Row: Identifiable {
        let id: String
        let a: Double?
        let b: Double?
        let unit: String
    }

    private var rows: [Row] {
        var out = [
            Row(id: "Serve, avg", a: a.serveAvg, b: b.serveAvg, unit: "km/h"),
            Row(id: "Serve, max", a: a.serveMax, b: b.serveMax, unit: "km/h"),
            Row(id: "Rally shot, avg", a: a.shotAvg, b: b.shotAvg, unit: "km/h"),
            Row(id: "Rally shot, max", a: a.shotMax, b: b.shotMax, unit: "km/h"),
            Row(id: "Landed in", a: a.inPct, b: b.inPct, unit: "%"),
            Row(id: "Into the net", a: a.netPct, b: b.netPct, unit: "%"),
        ]
        if a.firstServeIn != nil || b.firstServeIn != nil {
            out.append(Row(id: "1st serves in", a: a.firstServeIn, b: b.firstServeIn, unit: "%"))
        }
        out.append(Row(id: "Ran in rallies", a: a.distance, b: b.distance, unit: "m"))
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                playerTag(players[0].label, a.swatch, PlayerColor.a)
                Spacer()
                playerTag(players[1].label, b.swatch, PlayerColor.b)
            }
            .padding(.bottom, 10)

            ForEach(rows) { row in
                VStack(spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        value(row.a, row.unit).frame(maxWidth: .infinity, alignment: .leading)
                        Text(row.id).font(.caption).foregroundStyle(Theme.muted)
                            .fixedSize()
                        value(row.b, row.unit).frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    SplitBar(a: row.a, b: row.b)
                }
                .padding(.vertical, 7)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(row.id): \(players[0].label) \(spoken(row.a, row.unit)), \(players[1].label) \(spoken(row.b, row.unit))")
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
    }

    private func playerTag(_ label: String, _ swatch: [String]?, _ colour: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(colour).frame(width: 9, height: 9)
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
            if let swatch, swatch.count == 2 {
                // Shirt over shorts — how you tell which one is you.
                VStack(spacing: 1) {
                    RoundedRectangle(cornerRadius: 2).fill(Color(hexString: swatch[0]))
                    RoundedRectangle(cornerRadius: 2).fill(Color(hexString: swatch[1]))
                }
                .frame(width: 10, height: 15)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Theme.border, lineWidth: 0.5))
                .accessibilityLabel("Kit colours")
            }
        }
    }

    private func value(_ v: Double?, _ unit: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(v.map { "\(Int($0.rounded()))" } ?? "–")
                .font(.system(.title3, design: .rounded).weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
            if v != nil {
                Text(unit).font(.caption2).foregroundStyle(Theme.muted)
            }
        }
    }

    private func spoken(_ v: Double?, _ unit: String) -> String {
        guard let v else { return "unknown" }
        return "\(Int(v.rounded())) \(unit == "%" ? "percent" : unit == "m" ? "metres" : "kilometres per hour")"
    }
}

/// One bar, A's share from the left in A's colour and B's from the right.
private struct SplitBar: View {
    let a: Double?
    let b: Double?

    var body: some View {
        GeometryReader { geo in
            let total = (a ?? 0) + (b ?? 0)
            let fa = total > 0 ? CGFloat((a ?? 0) / total) : 0.5
            HStack(spacing: 2) {
                Capsule().fill(PlayerColor.a.opacity(a == nil ? 0.15 : 0.85))
                    .frame(width: max(2, (geo.size.width - 2) * fa))
                Capsule().fill(PlayerColor.b.opacity(b == nil ? 0.15 : 0.85))
            }
        }
        .frame(height: 4)
    }
}

// MARK: - Court drawing

/// The court drawn lengthwise, as on the web: screen x runs along the court
/// (net in the middle), screen y across it, with run-off all round.
struct CourtGeometry {
    static let half = 11.885, service = 6.4, singles = 4.115, doubles = 5.485
    static let padL = 4.8, padW = 2.2
    static let widthM = 2 * half + 2 * padL
    static let heightM = 2 * doubles + 2 * padW
    static let aspect = widthM / heightM

    static let court = Color(hex: 0x8A4A30)
    static let courtIn = Color(hex: 0xA35A3A)
    static let line = Color(hex: 0xF6EFE4)
    static let ink = Color(hex: 0x2A1A12)
    static let heat = Color(hex: 0xFFD84D)
    static let zone = Color(hex: 0xFFF6E0)

    let scale: CGFloat
    init(width: CGFloat) { scale = width / CGFloat(Self.widthM) }

    var size: CGSize { CGSize(width: CGFloat(Self.widthM) * scale, height: CGFloat(Self.heightM) * scale) }
    /// Along the court (court y) → screen x.
    func u(_ y: Double) -> CGFloat { CGFloat(y + Self.half + Self.padL) * scale }
    /// Across the court (court x) → screen y.
    func v(_ x: Double) -> CGFloat { CGFloat(x + Self.doubles + Self.padW) * scale }
    func point(_ p: (x: Double, y: Double)) -> CGPoint { CGPoint(x: u(p.y), y: v(p.x)) }

    func drawSurface(_ g: GraphicsContext) {
        g.fill(Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 10), with: .color(Self.court))
        let inner = CGRect(x: u(-Self.half), y: v(-Self.doubles),
                           width: CGFloat(2 * Self.half) * scale, height: CGFloat(2 * Self.doubles) * scale)
        g.fill(Path(inner), with: .color(Self.courtIn))
    }

    func drawLines(_ g: GraphicsContext) {
        let h = Self.half, sv = Self.service, sg = Self.singles, d = Self.doubles
        let lines: [(Double, Double, Double, Double)] = [
            (-d, -h, d, -h), (-d, h, d, h), (-d, -h, -d, h), (d, -h, d, h),
            (-sg, -h, -sg, h), (sg, -h, sg, h), (-sg, sv, sg, sv), (-sg, -sv, sg, -sv), (0, -sv, 0, sv),
        ]
        var p = Path()
        for (x1, y1, x2, y2) in lines {
            p.move(to: CGPoint(x: u(y1), y: v(x1)))
            p.addLine(to: CGPoint(x: u(y2), y: v(x2)))
        }
        g.stroke(p, with: .color(Self.line), lineWidth: 1)
        var net = Path()
        net.move(to: CGPoint(x: u(0), y: v(-d - 0.9)))
        net.addLine(to: CGPoint(x: u(0), y: v(d + 0.9)))
        g.stroke(net, with: .color(Self.line.opacity(0.7)), lineWidth: 2)
    }

    func label(_ g: GraphicsContext, _ text: String, atCourtY y: Double, colour: Color = line) {
        g.draw(Text(text).font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundColor(colour.opacity(0.8)),
               at: CGPoint(x: u(y), y: 11))
    }

    static func cross(_ g: GraphicsContext, at c: CGPoint, r: CGFloat, colour: Color, width: CGFloat = 2) {
        var p = Path()
        p.move(to: CGPoint(x: c.x - r, y: c.y - r)); p.addLine(to: CGPoint(x: c.x + r, y: c.y + r))
        p.move(to: CGPoint(x: c.x - r, y: c.y + r)); p.addLine(to: CGPoint(x: c.x + r, y: c.y - r))
        g.stroke(p, with: .color(colour), style: StrokeStyle(lineWidth: width, lineCap: .round))
    }

    static func circle(_ c: CGPoint, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    }
}

/// A court-shaped drawing surface that reports where it was tapped, in its own
/// coordinates.
private struct CourtCanvas: View {
    var onTap: ((CGPoint, CourtGeometry) -> Void)?
    let draw: (GraphicsContext, CourtGeometry) -> Void

    var body: some View {
        GeometryReader { geo in
            let court = CourtGeometry(width: geo.size.width)
            Canvas { g, _ in draw(g, court) }
                .contentShape(Rectangle())
                .gesture(SpatialTapGesture().onEnded { onTap?($0.location, court) }, including: onTap == nil ? .none : .all)
        }
        .aspectRatio(CourtGeometry.aspect, contentMode: .fit)
    }
}

// MARK: - Filters

private enum Stroke: String, CaseIterable {
    case serve, forehand, backhand
    var label: String { rawValue.capitalized }
}

private let rallyRoles: [(String, String)] = [("serving", "Serving"), ("receiving", "Receiving")]

/// Forehand and backhand aren't detected yet; rally shots count as forehands.
private func strokeOf(_ s: StatsShot) -> Stroke { s.serve ? .serve : Stroke(rawValue: s.stroke ?? "") ?? .forehand }
private func isIn(_ s: StatsShot) -> Bool { s.landing == "in" || s.landing == "close" }
private func isOut(_ s: StatsShot) -> Bool { s.landing == "out" || s.landing == "net" }

private struct ShotFilter: Equatable {
    var players: Set<String>
    var strokes: Set<Stroke> = Set(Stroke.allCases)
    var roles: Set<String> = Set(rallyRoles.map(\.0))

    /// A shot passes when each group includes its value; a shot whose player or
    /// role isn't known passes only while that whole group is on.
    func passes(player: String?, stroke: Stroke, role: String?, playerCount: Int) -> Bool {
        let okPlayer = player.map { players.contains($0) } ?? (players.count == playerCount)
        let okRole = role.map { roles.contains($0) } ?? (roles.count == rallyRoles.count)
        return okPlayer && okRole && strokes.contains(stroke)
    }
}

/// The filters as three dropdown pills — who, which shots, which points — one
/// line on the narrowest iPhone. A row of eight toggle chips needed sideways
/// scrolling there, hid half its options off-screen, and could be set to
/// combinations nobody asks for; a menu per question, one answer each, covers
/// what people actually want to see. A pill turns clay while it's filtering,
/// and Reset appears to put everything back.
private struct FilterChips: View {
    @Binding var filter: ShotFilter
    let players: [(key: String, label: String)]
    var showStrokes = true

    private struct Option: Identifiable {
        let id: String
        let label: String
        /// The short form the pill shows.
        let short: String
        let dot: Color?
    }

    // MARK: Players

    private var playerOptions: [Option] {
        [Option(id: "all", label: "Both players", short: "Both", dot: nil)]
            + players.map { Option(id: $0.key, label: "\($0.label) only", short: $0.label, dot: PlayerColor.of($0.key)) }
    }

    private var playerChoice: String {
        filter.players.count == 1 ? filter.players.first! : "all"
    }

    private func choosePlayer(_ id: String) {
        filter.players = id == "all" ? Set(players.map(\.key)) : [id]
    }

    // MARK: Shots

    private static let shotOptions = [
        Option(id: "all", label: "All shots", short: "All shots", dot: nil),
        Option(id: "serve", label: "Serves", short: "Serves", dot: nil),
        Option(id: "rally", label: "Rally shots", short: "Rally shots", dot: nil),
        Option(id: "forehand", label: "Forehands", short: "Forehands", dot: nil),
        Option(id: "backhand", label: "Backhands", short: "Backhands", dot: nil),
    ]

    private var shotChoice: String {
        switch filter.strokes {
        case Set(Stroke.allCases): return "all"
        case [.forehand, .backhand]: return "rally"
        default: return filter.strokes.count == 1 ? filter.strokes.first!.rawValue : "all"
        }
    }

    private func chooseShot(_ id: String) {
        switch id {
        case "all": filter.strokes = Set(Stroke.allCases)
        case "rally": filter.strokes = [.forehand, .backhand]
        default: filter.strokes = Stroke(rawValue: id).map { [$0] } ?? Set(Stroke.allCases)
        }
    }

    // MARK: Points

    private static let roleOptions = [Option(id: "all", label: "All points", short: "All points", dot: nil)]
        + rallyRoles.map { Option(id: $0.0, label: "Their \($0.1.lowercased()) points", short: $0.1, dot: nil) }

    private var roleChoice: String {
        filter.roles.count == 1 ? filter.roles.first! : "all"
    }

    private func chooseRole(_ id: String) {
        filter.roles = id == "all" ? Set(rallyRoles.map(\.0)) : [id]
    }

    private var isFiltering: Bool {
        playerChoice != "all" || (showStrokes && shotChoice != "all") || roleChoice != "all"
    }

    var body: some View {
        HStack(spacing: 6) {
            pill(title: "Players", icon: "person.2.fill", options: playerOptions,
                 choice: playerChoice, choose: choosePlayer)
            if showStrokes {
                pill(title: "Shots", icon: "figure.tennis", options: Self.shotOptions,
                     choice: shotChoice, choose: chooseShot)
            }
            pill(title: "Points", icon: "tennisball.fill", options: Self.roleOptions,
                 choice: roleChoice, choose: chooseRole)
            if isFiltering {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        choosePlayer("all"); chooseShot("all"); chooseRole("all")
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 30, height: 30)
                        .background(Theme.surface2, in: Circle())
                        .overlay(Circle().stroke(Theme.border, lineWidth: 1))
                        .foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reset filters")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isFiltering)
    }

    private func pill(title: String, icon: String, options: [Option], choice: String,
                      choose: @escaping (String) -> Void) -> some View {
        let picked = options.first { $0.id == choice } ?? options[0]
        let on = choice != "all"
        return Menu {
            Section(title) {
                ForEach(options) { o in
                    Button { withAnimation(.easeInOut(duration: 0.15)) { choose(o.id) } } label: {
                        if o.id == choice {
                            Label(o.label, systemImage: "checkmark")
                        } else {
                            Text(o.label)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                if let dot = picked.dot {
                    Circle().fill(dot).frame(width: 7, height: 7)
                } else {
                    Image(systemName: icon).font(.system(size: 10, weight: .semibold))
                }
                Text(picked.short)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                    .opacity(0.7)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(on ? Theme.accent.opacity(0.18) : Theme.surface2, in: Capsule())
            .overlay(Capsule().stroke(on ? Theme.accent.opacity(0.7) : Theme.border, lineWidth: 1))
            .foregroundStyle(on ? Theme.text : Theme.muted)
            .contentShape(Capsule())
        }
        .accessibilityLabel("\(title): \(picked.label)")
    }
}

// MARK: - Placement

/// A shot as the placement views draw it: turned so its hitter is on the left.
private struct Placed {
    let shot: StatsShot
    let index: Int
    let from: (x: Double, y: Double)
    let at: (x: Double, y: Double)?
}

/// Every fitted shot with somewhere to draw: struck on the hitter's own side,
/// bouncing on the far side of the net (or into the net). A bounce on the
/// hitter's own side is the fit failing, so it's left out.
private func placedShots(_ stats: MatchStats) -> [Placed] {
    let g = CourtGeometry.self
    return stats.shots.enumerated().compactMap { i, s in
        guard let f = s.from, f.count == 2 else { return nil }
        let flip = s.hitter == "far" ? -1.0 : 1.0
        let from = (x: f[0] * flip, y: f[1] * flip)
        let at = courtPoint(s.bounce, flip: flip)
        guard from.y < 0.5, from.y > -g.half - g.padL + 0.4, abs(from.x) < g.doubles + g.padW - 0.4 else { return nil }
        if let at { guard at.y > 0 else { return nil } } else if s.landing != "net" { return nil }
        return Placed(shot: s, index: i, from: from, at: at)
    }
}

private func clampTo(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }

/// A court point from the analysis's `[x, y]`, scaled by `flip` (±1 turns it
/// to the other end). Spelt out rather than inferred inside `? :` with `nil`,
/// which Xcode Cloud's compiler could not type-check.
private func courtPoint(_ p: [Double]?, flip: Double) -> (x: Double, y: Double)? {
    guard let p, p.count == 2 else { return nil }
    return (x: p[0] * flip, y: p[1] * flip)
}

private func mmss(_ s: Double) -> String { PlayerModel.timeLabel(s) }

private struct BlockHeader: View {
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
            Spacer()
            Text(detail).font(.caption).foregroundStyle(Theme.muted)
        }
    }
}

private struct PlacementBlock: View {
    let stats: MatchStats
    let players: [(key: String, label: String)]
    let playerOf: (StatsShot) -> String?
    let name: (String?) -> String
    let onSeek: (Double) -> Void

    @State private var filter: ShotFilter
    @State private var picked: Int?

    init(stats: MatchStats, players: [(key: String, label: String)], playerOf: @escaping (StatsShot) -> String?,
         name: @escaping (String?) -> String, onSeek: @escaping (Double) -> Void) {
        self.stats = stats
        self.players = players
        self.playerOf = playerOf
        self.name = name
        self.onSeek = onSeek
        _filter = State(initialValue: ShotFilter(players: Set(players.map(\.key))))
    }

    private var placed: [Placed] { placedShots(stats) }
    private var shown: [Placed] {
        placed.filter { filter.passes(player: playerOf($0.shot), stroke: strokeOf($0.shot), role: $0.shot.role, playerCount: players.count) }
    }

    var body: some View {
        let shown = shown
        let hot = picked.flatMap { i in shown.first { $0.index == i } }
        VStack(alignment: .leading, spacing: 10) {
            BlockHeader(title: "Shot placement", detail: "\(shown.count) shots")
            FilterChips(filter: $filter, players: players)
                .onChange(of: filter) { _, _ in picked = nil }
            CourtCanvas(onTap: { location, court in
                picked = nearest(to: location, in: shown, court: court)
            }) { g, court in
                draw(g, court, shown: shown, hot: hot)
            }
            .accessibilityElement()
            .accessibilityLabel("Where each shot was hit from, left, and where it bounced, right. \(shown.count) shots.")
            caption(hot)
        }
    }

    private func hitPoint(_ p: Placed, _ court: CourtGeometry) -> CGPoint {
        let g = CourtGeometry.self
        return court.point((x: clampTo(p.from.x, -g.doubles - g.padW + 0.4, g.doubles + g.padW - 0.4),
                            y: clampTo(p.from.y, -g.half - g.padL + 0.4, 0)))
    }

    private func bouncePoint(_ p: Placed, _ court: CourtGeometry) -> CGPoint? {
        let g = CourtGeometry.self
        guard let at = p.at, at.y < g.half + g.padL - 0.3, abs(at.x) < g.doubles + g.padW - 0.3 else { return nil }
        return court.point(at)
    }

    private func nearest(to location: CGPoint, in shown: [Placed], court: CourtGeometry) -> Int? {
        var best: (Int, CGFloat)?
        for p in shown {
            for pt in [hitPoint(p, court), bouncePoint(p, court)].compactMap({ $0 }) {
                let d = hypot(pt.x - location.x, pt.y - location.y)
                if d < 22, d < (best?.1 ?? .infinity) { best = (p.index, d) }
            }
        }
        // Tapping the same shot again (or empty court) lets go of it.
        return best.map(\.0) == picked ? nil : best?.0
    }

    private func draw(_ g: GraphicsContext, _ court: CourtGeometry, shown: [Placed], hot: Placed?) {
        court.drawSurface(g)
        court.drawLines(g)
        court.label(g, "HIT FROM", atCourtY: -CourtGeometry.half / 2)
        court.label(g, "BOUNCED", atCourtY: CourtGeometry.half / 2)

        if let hot {
            let c = PlayerColor.of(playerOf(hot.shot))
            let start = hitPoint(hot, court)
            let end = hot.at.map { court.point($0) } ?? court.point((x: hot.from.x * 0.15, y: 0))
            var p = Path(); p.move(to: start); p.addLine(to: end)
            g.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 2.5, dash: hot.at == nil ? [5, 4] : []))
        }

        for p in shown {
            let c = PlayerColor.of(playerOf(p.shot))
            let dim = hot != nil && hot?.index != p.index
            var layer = g
            layer.opacity = dim ? 0.18 : p.shot.doubt != nil ? 0.55 : 1
            let h = hitPoint(p, court)
            if isOut(p.shot) {
                CourtGeometry.cross(layer, at: h, r: 3.6, colour: c)
            } else if isIn(p.shot) {
                layer.stroke(CourtGeometry.circle(h, 4), with: .color(c), lineWidth: 2)
            } else {
                layer.fill(CourtGeometry.circle(h, 2.2), with: .color(c))
            }
            if let b = bouncePoint(p, court) {
                if p.shot.landing == "out" {
                    CourtGeometry.cross(layer, at: b, r: 3.6, colour: c)
                } else {
                    layer.fill(CourtGeometry.circle(b, 4), with: .color(c))
                    layer.stroke(CourtGeometry.circle(b, 4), with: .color(CourtGeometry.ink), lineWidth: 1)
                }
            }
        }
    }

    @ViewBuilder private func caption(_ hot: Placed?) -> some View {
        if let hot {
            let s = hot.shot
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(playerOf(s))).font(.caption.weight(.bold)).foregroundStyle(PlayerColor.of(playerOf(s)))
                    Text("\(strokeOf(s) == .serve ? "Serve" : "Rally shot") · \(Int(s.speed.rounded())) km/h · \(landingText(s.landing)) · \(mmss(s.t))")
                        .font(.caption).foregroundStyle(Theme.text)
                }
                Spacer()
                Button { onSeek(max(0, s.t - 1)) } label: {
                    Label("Play", systemImage: "play.fill")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Theme.accent, in: Capsule())
                        .foregroundStyle(Theme.text)
                }
                .buttonStyle(.plain)
            }
        } else {
            Text("Hit from: ○ landed in, × out or into the net. Bounced: ● in, × out. Tap a shot to join them and play it.")
                .font(.caption2).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func landingText(_ landing: String?) -> String {
        switch landing {
        case "net": return "into the net"
        case "close": return "on the line"
        case let l?: return l
        default: return "not called"
        }
    }
}

// MARK: - Position heatmap and zones

private struct PositionBlock: View {
    let stats: MatchStats
    let players: [(key: String, label: String)]
    let playerOf: (StatsShot) -> String?

    @State private var filter: ShotFilter

    init(stats: MatchStats, players: [(key: String, label: String)], playerOf: @escaping (StatsShot) -> String?) {
        self.stats = stats
        self.players = players
        self.playerOf = playerOf
        _filter = State(initialValue: ShotFilter(players: Set(players.map(\.key))))
    }

    // The nine zones: in front of the service line, between it and the
    // baseline, and behind it; by left / middle / right thirds of the singles
    // width (the outer thirds run out to the edge).
    private static let depth = [0, CourtGeometry.service, CourtGeometry.half, CourtGeometry.half + CourtGeometry.padL]
    private static let across = [-CourtGeometry.doubles - CourtGeometry.padW, -CourtGeometry.singles / 3,
                                 CourtGeometry.singles / 3, CourtGeometry.doubles + CourtGeometry.padW]

    private struct Zones {
        var cells = Array(repeating: (inn: 0, out: 0), count: 9)
        var landedIn = 0, out = 0, net = 0
        var called: Int { landedIn + out + net }
        var maxCell: Int { max(1, cells.map { $0.inn + $0.out }.max() ?? 1) }
    }

    private var zones: Zones {
        var z = Zones()
        let band = { (edges: [Double], v: Double) -> Int? in
            (0..<(edges.count - 1)).first { v >= edges[$0] && v < edges[$0 + 1] }
        }
        for p in placedShots(stats)
        where filter.passes(player: playerOf(p.shot), stroke: strokeOf(p.shot), role: p.shot.role, playerCount: players.count) {
            let s = p.shot
            guard isIn(s) || isOut(s) else { continue }
            if s.landing == "net" { z.net += 1 } else if s.landing == "out" { z.out += 1 } else { z.landedIn += 1 }
            guard let d = band(Self.depth, -p.from.y), let a = band(Self.across, p.from.x) else { continue }
            if isIn(s) { z.cells[d * 3 + a].inn += 1 } else { z.cells[d * 3 + a].out += 1 }
        }
        return z
    }

    /// Time on court, as the heatmap draws it: one square per grid cell with any.
    private struct HeatMap {
        struct Cell { let x: Double, y: Double, v: Double }
        let cells: [Cell]
        let max: Double
        let cell: Double
    }

    /// The selected players' time on court, summed over the selected roles.
    ///
    /// A named type, not a tuple: returning an unlabelled tuple through `? :`
    /// into a labelled optional one crashed the type checker on Xcode Cloud
    /// ("failed to produce diagnostic for expression").
    private var heat: HeatMap? {
        guard let m = stats.movement else { return nil }
        var sum = Array(repeating: 0.0, count: m.nx * m.ny)
        for (key, grid) in m.grids {
            let parts = key.split(separator: ":").map(String.init)
            guard parts.count == 2, filter.players.contains(parts[0]) else { continue }
            if parts[1] == "any" ? filter.roles.count != rallyRoles.count : !filter.roles.contains(parts[1]) { continue }
            for k in 0..<min(grid.count, sum.count) { sum[k] += grid[k] }
        }
        var cells: [HeatMap.Cell] = []
        var top = 0.0
        for (k, v) in sum.enumerated() where v > 0 {
            cells.append(HeatMap.Cell(x: m.x0 + Double(k % m.nx) * m.cell, y: m.y0 + Double(k / m.nx) * m.cell, v: v))
            top = max(top, v)
        }
        guard top > 0 else { return nil }
        return HeatMap(cells: cells, max: top, cell: m.cell)
    }

    var body: some View {
        let z = zones
        VStack(alignment: .leading, spacing: 10) {
            BlockHeader(
                title: "Court position & placement",
                detail: z.called > 0 ? "\(Int((100 * Double(z.landedIn) / Double(z.called)).rounded()))% in · \(z.out) out · \(z.net) net" : "no called shots"
            )
            FilterChips(filter: $filter, players: players)
            CourtCanvas { g, court in draw(g, court, zones: z) }
                .accessibilityElement()
                .accessibilityLabel("Where the players stood during points, left, and how their shots from nine zones went, right.")
            Text("Left: where they stood while the ball was in play, brighter for more time. Right: their own half again, mirrored, in nine zones by where each shot was hit from — the share that landed in (out includes the net).")
                .font(.caption2).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func draw(_ g: GraphicsContext, _ court: CourtGeometry, zones z: Zones) {
        court.drawSurface(g)

        if let heat {
            var layer = g
            layer.clip(to: Path(CGRect(x: 0, y: 0, width: court.size.width / 2, height: court.size.height)))
            layer.addFilter(.blur(radius: CGFloat(heat.cell) * court.scale * 0.35))
            let side = CGFloat(heat.cell) * court.scale + 0.5
            for c in heat.cells {
                let o = min(1, pow(c.v / heat.max, 0.45) * 1.2)
                layer.fill(Path(CGRect(x: court.u(c.y), y: court.v(c.x), width: side, height: side)),
                           with: .color(CourtGeometry.heat.opacity(o)))
            }
        }

        let d = Self.depth, a = Self.across
        for k in 0..<9 {
            let (row, col) = (k / 3, k % 3)
            let n = z.cells[k].inn + z.cells[k].out
            let rect = CGRect(x: court.u(d[row]), y: court.v(a[col]),
                              width: court.u(d[row + 1]) - court.u(d[row]), height: court.v(a[col + 1]) - court.v(a[col]))
            g.fill(Path(rect), with: .color(CourtGeometry.zone.opacity(0.06 + 0.55 * Double(n) / Double(z.maxCell))))
        }
        court.drawLines(g)

        var dashes = Path()
        for k in [1, 2] {
            dashes.move(to: CGPoint(x: court.u(0), y: court.v(a[k])))
            dashes.addLine(to: CGPoint(x: court.u(d[3]), y: court.v(a[k])))
        }
        for y in [CourtGeometry.service, CourtGeometry.half] {
            dashes.move(to: CGPoint(x: court.u(y), y: court.v(a[0])))
            dashes.addLine(to: CGPoint(x: court.u(y), y: court.v(a[3])))
        }
        g.stroke(dashes, with: .color(CourtGeometry.line.opacity(0.5)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))

        for k in 0..<9 {
            let (row, col) = (k / 3, k % 3)
            let n = z.cells[k].inn + z.cells[k].out
            let centre = CGPoint(x: (court.u(d[row]) + court.u(d[row + 1])) / 2, y: (court.v(a[col]) + court.v(a[col + 1])) / 2)
            let pct = n > 0 ? "\(Int((100 * Double(z.cells[k].inn) / Double(n)).rounded()))%" : "–"
            let label = Text(pct).font(.system(size: 10, weight: .bold).monospacedDigit()).foregroundColor(CourtGeometry.ink)
            let resolved = g.resolve(label)
            let sz = resolved.measure(in: CGSize(width: 100, height: 30))
            var chip = g
            chip.opacity = n > 0 ? 1 : 0.55
            chip.fill(Path(roundedRect: CGRect(x: centre.x - sz.width / 2 - 4, y: centre.y - sz.height / 2 - 1.5,
                                               width: sz.width + 8, height: sz.height + 3), cornerRadius: 4),
                      with: .color(CourtGeometry.zone.opacity(0.9)))
            chip.draw(resolved, at: centre)
        }
        court.label(g, "POSITION", atCourtY: -CourtGeometry.half / 2)
        court.label(g, "HIT FROM · % IN", atCourtY: CourtGeometry.half / 2)
    }
}

// MARK: - Best rallies

/// The most intense rallies, and the one picked drawn on a court: player A's
/// end on the left, B's on the right, each shot from where it was struck to
/// where it bounced, then on to the next contact.
private struct BestRalliesBlock: View {
    let stats: MatchStats
    let byPerson: Bool
    let playerOf: (StatsShot) -> String?
    let name: (String?) -> String
    let onSeek: (Double) -> Void

    @State private var picked: Int?

    private var best: [StatsRally] {
        Array(stats.rallies.filter { $0.shots >= 3 }.sorted { $0.intensity > $1.intensity }.prefix(5))
    }

    var body: some View {
        let best = best
        if let rally = best.first(where: { $0.idx == picked }) ?? best.first {
            VStack(alignment: .leading, spacing: 10) {
                BlockHeader(title: "Best rallies", detail: "tap one to see it")
                VStack(spacing: 0) {
                    ForEach(Array(best.enumerated()), id: \.element.idx) { k, r in
                        row(k, r, on: r.idx == rally.idx)
                        if k < best.count - 1 { Divider().overlay(Theme.border) }
                    }
                }
                .padding(.horizontal, 12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
                RallyCourt(stats: stats, rally: rally, byPerson: byPerson, playerOf: playerOf, name: name, onSeek: onSeek)
            }
        }
    }

    private func row(_ k: Int, _ r: StatsRally, on: Bool) -> some View {
        HStack(spacing: 12) {
            Text("\(k + 1)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(on ? Theme.text : Theme.muted)
                .frame(width: 22, height: 22)
                .background(on ? Theme.accent : Theme.surface2, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("\(mmss(r.start)) · \(Int(r.shots)) shots")
                        .font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.text)
                    if r.high {
                        Text("HIGH INTENSITY")
                            .font(.system(size: 8, weight: .bold)).tracking(0.4)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Theme.accent.opacity(0.2), in: Capsule())
                            .foregroundStyle(Theme.accent)
                    }
                }
                Text([r.maxSpeed.map { "\(Int($0.rounded())) km/h top" }, r.run > 0 ? "\(Int(r.run.rounded())) m run" : nil]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button { onSeek(max(0, r.start - 1)) } label: {
                Image(systemName: "play.circle.fill").font(.title3).foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Play the rally at \(mmss(r.start))")
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { picked = r.idx } }
    }
}

private struct RallyCourt: View {
    let stats: MatchStats
    let rally: StatsRally
    let byPerson: Bool
    let playerOf: (StatsShot) -> String?
    let name: (String?) -> String
    let onSeek: (Double) -> Void

    private struct Step {
        let shot: StatsShot
        let hit: (x: Double, y: Double)
        let bounce: (x: Double, y: Double)?
        let colour: Color
    }

    private var steps: [Step] {
        let g = CourtGeometry.self
        let shots = stats.shots.filter { $0.rally == rally.idx && $0.from?.count == 2 }.sorted { $0.t < $1.t }
        // Turn the court so player A (or the camera end) is on the left.
        let left: String = byPerson
            ? shots.first { $0.player == "A" }?.hitter ?? (shots.first { $0.player == "B" }?.hitter == "near" ? "far" : "near")
            : "near"
        let flip = left == "near" ? 1.0 : -1.0
        let inside = { (p: (x: Double, y: Double)) -> (x: Double, y: Double) in
            (x: clampTo(p.x, -g.doubles - g.padW + 0.5, g.doubles + g.padW - 0.5),
             y: clampTo(p.y, -g.half - g.padL + 0.5, g.half + g.padL - 0.5))
        }
        return shots.map { s in
            let hit = inside((x: s.from![0] * flip, y: s.from![1] * flip))
            var bounce = courtPoint(s.bounce, flip: flip)
            if let b = bounce, (b.y >= 0) == (hit.y >= 0) { bounce = nil }
            if let b = bounce, abs(b.x) > g.doubles + g.padW - 0.3 || abs(b.y) > g.half + g.padL - 0.3 { bounce = nil }
            return Step(shot: s, hit: hit, bounce: bounce, colour: PlayerColor.of(playerOf(s)))
        }
    }

    var body: some View {
        let steps = steps
        let leftWho = byPerson ? "A" : "near", rightWho = byPerson ? "B" : "far"
        VStack(alignment: .leading, spacing: 8) {
            CourtCanvas(onTap: { location, court in
                if let s = steps.min(by: { dist($0, location, court) < dist($1, location, court) }),
                   dist(s, location, court) < 24 {
                    onSeek(max(0, s.shot.t - 1))
                }
            }) { g, court in
                court.drawSurface(g)
                court.drawLines(g)
                court.label(g, name(leftWho).uppercased(), atCourtY: -CourtGeometry.half / 2, colour: PlayerColor.of(leftWho))
                court.label(g, name(rightWho).uppercased(), atCourtY: CourtGeometry.half / 2, colour: PlayerColor.of(rightWho))
                for (k, s) in steps.enumerated() {
                    let next = k + 1 < steps.count ? steps[k + 1].hit : nil
                    let h = court.point(s.hit)
                    if let b = s.bounce {
                        var p = Path(); p.move(to: h); p.addLine(to: court.point(b))
                        g.stroke(p, with: .color(s.colour), lineWidth: 2)
                        if let next {
                            var q = Path(); q.move(to: court.point(b)); q.addLine(to: court.point(next))
                            g.stroke(q, with: .color(s.colour.opacity(0.8)), style: StrokeStyle(lineWidth: 1.4, dash: [4, 4]))
                        }
                    } else if let next {
                        var p = Path(); p.move(to: h); p.addLine(to: court.point(next))
                        g.stroke(p, with: .color(s.colour), lineWidth: 2)
                    }
                }
                for (k, s) in steps.enumerated() {
                    if let b = s.bounce {
                        if s.shot.landing == "out" {
                            CourtGeometry.cross(g, at: court.point(b), r: 3.6, colour: s.colour)
                        } else {
                            g.fill(CourtGeometry.circle(court.point(b), 3.8), with: .color(s.colour))
                            g.stroke(CourtGeometry.circle(court.point(b), 3.8), with: .color(CourtGeometry.ink), lineWidth: 1)
                        }
                    }
                    let h = court.point(s.hit)
                    g.fill(CourtGeometry.circle(h, 7.5), with: .color(CourtGeometry.ink))
                    g.stroke(CourtGeometry.circle(h, 7.5), with: .color(s.colour), lineWidth: 2)
                    g.draw(Text("\(k + 1)").font(.system(size: 8.5, weight: .bold)).foregroundColor(CourtGeometry.line), at: h)
                }
            }
            .accessibilityElement()
            .accessibilityLabel("Rally at \(mmss(rally.start)), \(name(leftWho)) on the left, \(name(rightWho)) on the right.")
            Text(steps.isEmpty
                 ? "We couldn't follow the ball closely enough in this rally to draw it."
                 : "Numbered circles are where each shot was struck, dots where it bounced (× out), dashes the ball on to the next contact. \(steps.count) of \(Int(rally.shots)) shots tracked — tap one to play it.")
                .font(.caption2).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func dist(_ s: Step, _ p: CGPoint, _ court: CourtGeometry) -> CGFloat {
        let h = court.point(s.hit)
        return hypot(h.x - p.x, h.y - p.y)
    }
}

// MARK: - Service games

private struct ServiceGamesStrip: View {
    let games: [StatsGame]
    let onSeek: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SERVICE GAMES").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(games.enumerated()), id: \.offset) { i, g in
                        Button { onSeek(max(0, g.start - 2)) } label: {
                            VStack(spacing: 2) {
                                Text(g.server).font(.subheadline.weight(.bold)).foregroundStyle(Theme.text)
                                Text("\(Int(g.points)) pts").font(.caption2).foregroundStyle(Theme.muted)
                            }
                            .frame(width: 46).padding(.vertical, 7)
                            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(alignment: .top) {
                                UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8)
                                    .fill(PlayerColor.of(g.server)).frame(height: 3)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Game \(i + 1) at \(mmss(g.start)): player \(g.server) served, \(Int(g.points)) points")
                        if g.changeoverAfter {
                            Image(systemName: "arrow.left.arrow.right")
                                .font(.caption2).foregroundStyle(Theme.muted)
                                .accessibilityLabel("Players change ends")
                        }
                    }
                }
            }
        }
    }
}

extension Color {
    /// "#rrggbb" from the analysis (kit swatches); grey if it doesn't parse.
    init(hexString: String) {
        let digits = hexString.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        self.init(hex: UInt32(digits, radix: 16) ?? 0x808080)
    }
}
