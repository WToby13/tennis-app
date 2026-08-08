import SwiftUI

/// One service game: a run of consecutive rallies sharing a `game` number, as
/// stamped by the structural smoother. Mirrors `buildServiceGames` on the web.
private struct ServiceGame: Identifiable {
    let id = UUID()
    let game: Int
    let server: String?
    let startS: Double
    let points: Int
}

/// The AI rally breakdown for a cloud match — the iOS counterpart of the web
/// `RallySegments` component. Shows the match split into service games and
/// rallies; tapping either jumps the player to that moment.
///
/// State is seeded from the video-detail fetch, so this only calls the analyze
/// route to start a run or to poll one that's in flight. Polling matters: there's
/// no background worker server-side, so the owner's GET is what advances the
/// TwelveLabs task and writes the segments back.
struct RallyBreakdown: View {
    let videoId: String
    let canAnalyze: Bool
    let onSeek: (Double) -> Void

    @State private var status: String
    @State private var errorText: String?
    @State private var segments: [AnalysisSegment]
    @State private var players: AnalysisPlayers?
    @State private var busy = false
    @State private var setupOpen = false
    @State private var trimText = ""
    @State private var name1 = ""
    @State private var name2 = ""

    private let api = UploadAPI()

    /// How often to poll while a run is in flight. Analysis takes minutes, so a
    /// slow cadence is plenty and keeps the request count down.
    private static let pollInterval: Duration = .seconds(4)

    init(videoId: String,
         canAnalyze: Bool,
         initialStatus: String?,
         initialError: String?,
         initialSegments: [AnalysisSegment],
         initialPlayers: AnalysisPlayers?,
         onSeek: @escaping (Double) -> Void) {
        self.videoId = videoId
        self.canAnalyze = canAnalyze
        self.onSeek = onSeek
        _status = State(initialValue: initialStatus ?? "none")
        _errorText = State(initialValue: initialError)
        _segments = State(initialValue: initialSegments)
        _players = State(initialValue: initialPlayers)
        _name1 = State(initialValue: initialPlayers?.player1 ?? "")
        _name2 = State(initialValue: initialPlayers?.player2 ?? "")
    }

    // MARK: Derived

    /// Group rallies into service games: consecutive points sharing a `game`
    /// number become one entry, labelled with that game's server.
    private var games: [ServiceGame] {
        var out: [ServiceGame] = []
        for s in segments {
            let g = s.metadata?.game.map { Int($0) }
            let start = s.startS ?? 0
            if let last = out.last, let g, last.game == g {
                out[out.count - 1] = ServiceGame(
                    game: last.game, server: last.server, startS: last.startS, points: last.points + 1
                )
            } else {
                out.append(ServiceGame(
                    game: g ?? out.count + 1, server: s.metadata?.server, startS: start, points: 1
                ))
            }
        }
        return out
    }

    /// Human label for a model player id, falling back to the generic name.
    private func displayPlayer(_ id: String?) -> String {
        switch id {
        case "player_1": return players?.player1?.nonEmpty ?? "Player 1"
        case "player_2": return players?.player2?.nonEmpty ?? "Player 2"
        default: return "—"
        }
    }

    // MARK: Body

    /// Someone who can't run a breakdown and has no result to look at gets nothing —
    /// no explainer, no dead button.
    private var isHidden: Bool {
        !canAnalyze && segments.isEmpty && status != "processing"
    }

    var body: some View {
        Group {
            if !isHidden { content }
        }
        // Restarts whenever the status changes; only the processing state polls.
        .task(id: status) {
            guard status == "processing" else { return }
            await pollUntilSettled()
        }
        .sheet(isPresented: $setupOpen) { setupSheet }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            switch status {
            case "processing":
                processingRow
            case "failed":
                if let errorText { errorRow(errorText) }
                runButton(label: "Try again")
            case "ready":
                if segments.isEmpty {
                    Text("No rallies were detected in this match.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                    runButton(label: "Re-analyse")
                } else {
                    gamesRow
                    ralliesList
                    runButton(label: "Re-analyse")
                }
            default:
                Text("Split this match into service games and rallies, so you can jump straight to any point.")
                    .font(.footnote).foregroundStyle(Theme.muted)
                runButton(label: "Run AI breakdown")
            }
        }
        .padding(.horizontal, 16)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("AI Breakdown").font(.headline).foregroundStyle(Theme.text)
            Text("BETA")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(Capsule().stroke(Theme.accent.opacity(0.6), lineWidth: 1))
            Spacer()
        }
    }

    private var processingRow: some View {
        HStack(spacing: 10) {
            ProgressView().tint(Theme.accent)
            Text("Analysing the match… this takes a few minutes.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func errorRow(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Service games as a horizontal strip — the at-a-glance shape of the match.
    private var gamesRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SERVICE GAMES")
                .font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(games) { g in
                        Button { onSeek(g.startS) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Game \(g.game)")
                                    .font(.caption.weight(.bold)).foregroundStyle(Theme.text)
                                Text(displayPlayer(g.server))
                                    .font(.caption2).foregroundStyle(Theme.accent)
                                Text("\(g.points) \(g.points == 1 ? "point" : "points")")
                                    .font(.caption2).foregroundStyle(Theme.muted)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var ralliesList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("RALLIES")
                .font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            VStack(spacing: 0) {
                ForEach(Array(segments.enumerated()), id: \.element.id) { i, s in
                    Button { onSeek(s.startS ?? 0) } label: {
                        HStack(spacing: 12) {
                            Text("\(i + 1)")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(Theme.muted)
                                .frame(width: 24, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(timeLabel(s.startS ?? 0))
                                    .font(.subheadline.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(Theme.text)
                                Text(rallyDetail(s))
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Image(systemName: "play.circle")
                                .foregroundStyle(Theme.accent)
                        }
                        .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                    if i < segments.count - 1 {
                        Divider().overlay(Theme.border)
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        }
    }

    /// One-line summary of a rally: who served, how long, how many shots.
    private func rallyDetail(_ s: AnalysisSegment) -> String {
        var bits: [String] = []
        if let server = s.metadata?.server { bits.append("\(displayPlayer(server)) serving") }
        if let start = s.startS, let end = s.endS, end > start {
            bits.append("\(Int((end - start).rounded()))s")
        }
        if let shots = s.metadata?.shots { bits.append("\(Int(shots)) shots") }
        return bits.isEmpty ? "Rally" : bits.joined(separator: " · ")
    }

    private func runButton(label: String) -> some View {
        Group {
            if canAnalyze {
                Button { setupOpen = true } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(Theme.text) }
                        Text(busy ? "Starting…" : label).font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Theme.accent, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
    }

    // MARK: Setup sheet

    private var setupSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Leave blank to start from the beginning", text: $trimText)
                        .keyboardType(.numbersAndPunctuation)
                } header: {
                    Text("Skip warm-up (seconds)")
                } footer: {
                    Text("Analysis starts from this point, so knock-up rallies don't get counted as games.")
                }
                Section {
                    TextField("Player 1 — starts near the camera", text: $name1)
                    TextField("Player 2 — starts far from the camera", text: $name2)
                } header: {
                    Text("Player names")
                } footer: {
                    Text("Optional. Used to label who served each game.")
                }
            }
            .navigationTitle("Run AI breakdown")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { setupOpen = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Run") {
                        setupOpen = false
                        start()
                    }
                }
            }
        }
    }

    // MARK: Actions

    private func start() {
        guard !busy else { return }
        busy = true
        errorText = nil
        let trim = Double(trimText.trimmingCharacters(in: .whitespaces))
        let chosen = AnalysisPlayers(player1: name1.nonEmpty, player2: name2.nonEmpty)
        Task {
            defer { busy = false }
            do {
                let r = try await api.startAnalysis(
                    videoId: videoId, startTimeSec: trim, players: chosen
                )
                players = chosen
                // Clear stale rallies so a re-run doesn't show the previous result
                // underneath the spinner.
                segments = []
                status = r.analysisStatus ?? "processing"
            } catch {
                status = "failed"
                errorText = error.localizedDescription
            }
        }
    }

    /// Poll until the run leaves "processing". Transient failures are ignored —
    /// a dropped poll shouldn't strand the UI when the next one would recover.
    private func pollUntilSettled() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.pollInterval)
            if Task.isCancelled { return }
            guard let r = try? await api.getAnalysis(videoId: videoId) else { continue }
            if let segs = r.segments { segments = segs }
            errorText = r.analysisError
            if let s = r.analysisStatus, s != "processing" {
                status = s
                return
            }
        }
    }

    private func timeLabel(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

extension String {
    /// The string, or nil when it's blank — for optional API fields.
    var nonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
