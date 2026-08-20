import Combine
import SwiftUI

/// Which way the player's rally-skip buttons move.
enum RallyDirection { case previous, next }

/// One service game: a run of consecutive rallies sharing a `game` number, as
/// stamped by the structural smoother. Mirrors `buildServiceGames` on the web.
struct ServiceGame: Identifiable {
    let id = UUID()
    let game: Int
    let server: String?
    let startS: Double
    var endS: Double
    var points: Int
    var shots: Int

    /// Group rallies into service games: consecutive points sharing a `game`
    /// number become one entry, labelled with that game's server.
    static func build(from segments: [AnalysisSegment]) -> [ServiceGame] {
        var out: [ServiceGame] = []
        for segment in segments {
            let start = segment.startS ?? 0
            let end = segment.endS ?? start
            let shots = Int(segment.metadata?.shots ?? 0)
            let number = segment.metadata?.game.map { Int($0) }
            if var last = out.last, let number, last.game == number {
                last.endS = max(last.endS, end)
                last.points += 1
                last.shots += shots
                out[out.count - 1] = last
            } else {
                out.append(ServiceGame(game: number ?? out.count + 1,
                                       server: segment.metadata?.server,
                                       startS: start, endS: end, points: 1, shots: shots))
            }
        }
        return out
    }
}

/// The AI rally breakdown's state for one match, owned by the Watch screen so the
/// portrait panel and the fullscreen timeline are the same run — start it in one
/// and the other is already showing it.
///
/// Seeded from the video-detail fetch, so this only calls the analyze route to
/// start a run or to poll one in flight. Polling still matters even with the
/// server-side sweep: it's what makes a finished run appear while you're looking
/// at it.
@MainActor
final class AnalysisModel: ObservableObject {
    @Published var status = "none"
    @Published var segments: [AnalysisSegment] = []
    @Published var players: AnalysisPlayers?
    @Published var errorText: String?
    @Published var busy = false

    private(set) var videoId: String?
    private(set) var canAnalyze = false

    private let api = UploadAPI()

    /// How often to poll while a run is in flight. Analysis takes minutes, so a
    /// slow cadence is plenty and keeps the request count down.
    private static let pollInterval: Duration = .seconds(4)

    /// Created empty and filled in when the video detail lands, so the Watch
    /// screen can hold one for the whole session — both the portrait panel and
    /// the fullscreen timeline observe this same object, and a run that finishes
    /// while you're in either one shows up in both.
    func seed(videoId: String, detail: VideoDetailResponse) {
        guard self.videoId == nil else { return }
        self.videoId = videoId
        canAnalyze = detail.canAnalyze ?? false
        status = detail.analysisStatus ?? "none"
        segments = detail.segments ?? []
        players = detail.analysisPlayers
        errorText = detail.analysisError
    }

    var games: [ServiceGame] { ServiceGame.build(from: segments) }

    var hasResult: Bool { !segments.isEmpty }

    /// Every shot the model counted across the match.
    var totalShots: Int {
        segments.reduce(0) { $0 + Int($1.metadata?.shots ?? 0) }
    }

    /// Someone who can't run a breakdown and has no result to look at gets
    /// nothing — no explainer, no dead button.
    var isHidden: Bool { !canAnalyze && segments.isEmpty && status != "processing" }

    /// Where each rally starts, in order — what the player's skip buttons move
    /// between.
    var rallyStarts: [Double] {
        segments.compactMap(\.startS).sorted()
    }

    /// The next rally after `time`, or nil at the last one.
    func nextRallyStart(after time: Double) -> Double? {
        rallyStarts.first { $0 > time + 0.25 }
    }

    /// Track-skip behaviour: once you're a couple of seconds into a rally, back
    /// takes you to the top of it; press again and you go to the one before.
    func previousRallyStart(before time: Double) -> Double? {
        rallyStarts.last { $0 < time - 2 } ?? rallyStarts.first
    }

    /// Human label for a model player id, falling back to the generic name.
    func nameOf(_ id: String?) -> String {
        switch id {
        case "player_1": return players?.player1?.nonEmpty ?? "Player 1"
        case "player_2": return players?.player2?.nonEmpty ?? "Player 2"
        default: return "—"
        }
    }

    func run(_ request: AnalysisRequest) {
        guard !busy, let videoId else { return }
        busy = true
        errorText = nil
        Task {
            defer { busy = false }
            do {
                let response = try await api.startAnalysis(
                    videoId: videoId,
                    startTimeSec: request.startTimeSec,
                    players: request.players
                )
                players = request.players
                // Clear stale rallies so a re-run doesn't show the previous
                // result underneath the spinner.
                segments = []
                status = response.analysisStatus ?? "processing"
            } catch {
                status = "failed"
                errorText = error.localizedDescription
            }
        }
    }

    /// Rename the players without re-running the analysis.
    func savePlayers(_ newPlayers: AnalysisPlayers) {
        guard let videoId else { return }
        players = newPlayers
        Task { try? await api.setAnalysisPlayers(videoId: videoId, players: newPlayers) }
    }

    /// Poll until the run leaves "processing". Transient failures are ignored —
    /// a dropped poll shouldn't strand the UI when the next one would recover.
    func pollUntilSettled() async {
        guard let videoId else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.pollInterval)
            if Task.isCancelled { return }
            guard let response = try? await api.getAnalysis(videoId: videoId) else { continue }
            if let segs = response.segments { segments = segs }
            errorText = response.analysisError
            if let settled = response.analysisStatus, settled != "processing" {
                status = settled
                return
            }
        }
    }
}

/// The AI rally breakdown as it reads down the page: the match's service games as
/// a strip you can skim, then every rally in order. Tapping either jumps the
/// player to that moment.
struct RallyBreakdown: View {
    @ObservedObject var model: AnalysisModel
    let onSeek: (Double) -> Void
    /// The shelf's answers, so the caller can tag the named players on the match.
    let onSetup: (MatchSetup, _ run: Bool) -> Void
    /// Anyone already tagged, offered in the shelf's dropdowns.
    let participants: [Participant]

    @State private var setupOpen = false

    var body: some View {
        Group {
            if !model.isHidden { content }
        }
        // Restarts whenever the status changes; only the processing state polls.
        .task(id: model.status) {
            guard model.status == "processing" else { return }
            await model.pollUntilSettled()
        }
        .sheet(isPresented: $setupOpen) {
            MatchSetupSheet(
                purpose: .cloudMatch,
                existing: participants,
                initialPlayers: model.players
            ) { setup in
                onSetup(setup, false)
            } onPrimary: { setup in
                onSetup(setup, true)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            switch model.status {
            case "processing":
                processingRow
            case "failed":
                if let errorText = model.errorText { errorRow(errorText) }
                runButton(label: "Try again")
            case "ready":
                if model.segments.isEmpty {
                    Text("No rallies were detected in this match.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                    runButton(label: "Re-analyse")
                } else {
                    summary
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

    /// The match in one line — how much tennis was actually played.
    private var summary: some View {
        let games = model.games.count
        let rallies = model.segments.count
        let shots = model.totalShots
        return Text("\(games) \(games == 1 ? "game" : "games") · \(rallies) \(rallies == 1 ? "rally" : "rallies") · \(shots) shots")
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.muted)
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
                    ForEach(model.games) { game in
                        Button { onSeek(game.startS) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Game \(game.game)")
                                    .font(.caption.weight(.bold)).foregroundStyle(Theme.text)
                                Text(model.nameOf(game.server))
                                    .font(.caption2).foregroundStyle(Theme.accent)
                                Text("\(game.points) \(game.points == 1 ? "point" : "points") · \(game.shots) shots")
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
                ForEach(Array(model.segments.enumerated()), id: \.element.id) { index, segment in
                    Button { onSeek(segment.startS ?? 0) } label: {
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(Theme.muted)
                                .frame(width: 24, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(PlayerModel.timeLabel(segment.startS ?? 0))
                                    .font(.subheadline.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(Theme.text)
                                Text(rallyDetail(segment))
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Image(systemName: "play.circle")
                                .foregroundStyle(Theme.accent)
                        }
                        .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                    if index < model.segments.count - 1 {
                        Divider().overlay(Theme.border)
                    }
                }
            }
            .padding(.horizontal, 12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        }
    }

    /// One-line summary of a rally: who served, how long, how many shots.
    private func rallyDetail(_ segment: AnalysisSegment) -> String {
        var bits: [String] = []
        if let server = segment.metadata?.server { bits.append("\(model.nameOf(server)) serving") }
        if let start = segment.startS, let end = segment.endS, end > start {
            bits.append("\(Int((end - start).rounded()))s")
        }
        if let shots = segment.metadata?.shots { bits.append("\(Int(shots)) shots") }
        return bits.isEmpty ? "Rally" : bits.joined(separator: " · ")
    }

    private func runButton(label: String) -> some View {
        Group {
            if model.canAnalyze {
                Button { setupOpen = true } label: {
                    HStack(spacing: 8) {
                        if model.busy { ProgressView().tint(Theme.text) }
                        Text(model.busy ? "Starting…" : label).font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Theme.accent, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(model.busy)
            }
        }
    }
}

extension String {
    /// The string, or nil when it's blank — for optional API fields.
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
