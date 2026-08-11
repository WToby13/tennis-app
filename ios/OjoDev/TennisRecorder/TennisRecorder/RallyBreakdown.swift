import Combine
import SwiftUI

/// The AI rally breakdown's state for one match, owned by the Watch screen so the
/// portrait breakdown and the landscape timeline are the same run — start it in
/// one and the other is already showing it.
///
/// Seeded from the video-detail fetch, so this only calls the analyze route to
/// start a run or to poll one in flight. Polling still matters even with the
/// server-side sweep: it's what makes a finished run appear while you're looking
/// at it.
@MainActor
final class AnalysisModel: ObservableObject {
    @Published var status: String
    @Published var segments: [AnalysisSegment]
    @Published var players: AnalysisPlayers?
    @Published var errorText: String?
    @Published var busy = false

    let videoId: String
    let canAnalyze: Bool

    private let api = UploadAPI()

    /// How often to poll while a run is in flight. Analysis takes minutes, so a
    /// slow cadence is plenty and keeps the request count down.
    private static let pollInterval: Duration = .seconds(4)

    init(videoId: String, detail: VideoDetailResponse) {
        self.videoId = videoId
        canAnalyze = detail.canAnalyze ?? false
        status = detail.analysisStatus ?? "none"
        segments = detail.segments ?? []
        players = detail.analysisPlayers
        errorText = detail.analysisError
    }

    var games: [ServiceGame] { ServiceGame.build(from: segments) }

    var hasResult: Bool { !segments.isEmpty }

    /// Someone who can't run a breakdown and has no result to look at gets
    /// nothing — no explainer, no dead button.
    var isHidden: Bool { !canAnalyze && segments.isEmpty && status != "processing" }

    /// Human label for a model player id, falling back to the generic name.
    func nameOf(_ id: String?) -> String {
        switch id {
        case "player_1": return players?.player1?.nonEmpty ?? "Player 1"
        case "player_2": return players?.player2?.nonEmpty ?? "Player 2"
        default: return "—"
        }
    }

    func run(_ request: AnalysisRequest) {
        guard !busy else { return }
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

    /// Poll until the run leaves "processing". Transient failures are ignored —
    /// a dropped poll shouldn't strand the UI when the next one would recover.
    func pollUntilSettled() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.pollInterval)
            if Task.isCancelled { return }
            guard let response = try? await api.getAnalysis(videoId: videoId) else { continue }
            if let segs = response.segments { segments = segs }
            errorText = response.analysisError
            if let s = response.analysisStatus, s != "processing" {
                status = s
                return
            }
        }
    }
}

/// The AI rally breakdown for a cloud match — the iOS counterpart of the web
/// `RallySegments` component. Shows the match as a timeline of service games and
/// rallies, plus the rally list; tapping either jumps the player to that moment.
struct RallyBreakdown: View {
    @ObservedObject var model: AnalysisModel
    let durationS: Double
    /// Tracked by the timeline's playhead.
    var player: PlayerModel?
    let onSeek: (Double) -> Void
    /// Names entered in the shelf, so the caller can tag them on the match.
    let onPlayersChosen: ([String]) -> Void
    /// Names offered as one-tap fills in the shelf (whoever's already tagged).
    let suggestions: [String]

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
            AnalyseSheet(
                confirmLabel: "Run",
                suggestions: suggestions,
                initialPlayers: model.players
            ) { request in
                onPlayersChosen(request.playerNames)
                model.run(request)
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
                    timeline
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

    private var timeline: some View {
        RallyTimeline(
            segments: model.segments,
            games: model.games,
            nameOf: model.nameOf,
            durationS: durationS,
            player: player,
            onSeek: onSeek
        )
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

    private var ralliesList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("RALLIES")
                .font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
            VStack(spacing: 0) {
                ForEach(Array(model.segments.enumerated()), id: \.element.id) { i, s in
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
                    if i < model.segments.count - 1 {
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
        if let server = s.metadata?.server { bits.append("\(model.nameOf(server)) serving") }
        if let start = s.startS, let end = s.endS, end > start {
            bits.append("\(Int((end - start).rounded()))s")
        }
        if let shots = s.metadata?.shots { bits.append("\(Int(shots)) shots") }
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
