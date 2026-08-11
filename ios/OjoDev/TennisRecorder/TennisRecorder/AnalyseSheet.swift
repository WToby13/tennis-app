import SwiftUI

/// Everything the AI breakdown needs to run, as collected by `AnalyseSheet`.
/// Carried through the uploader when the match isn't in the cloud yet, so
/// "Upload & Analyse" starts the run with the same answers the shelf collected.
struct AnalysisRequest: Codable, Equatable {
    var startTimeSec: Double?
    var players: AnalysisPlayers?

    var playerNames: [String] {
        [players?.player1, players?.player2].compactMap { $0?.nonEmpty }
    }
}

/// The shelf behind every "Upload & Analyse" / "Run AI breakdown" button: when
/// does the match actually start, and who's playing. Both answers are the
/// difference between a useful breakdown and a useless one — warm-up hitting
/// otherwise gets counted as games, and rallies come back labelled "Player 1".
///
/// The iOS counterpart of the web setup modal in `RallySegments.tsx`, presented
/// as a bottom sheet since it's reached from a card action.
struct AnalyseSheet: View {
    /// The confirm button's label — the shelf is shown both before an upload
    /// ("Upload & Analyse") and for a match already in the cloud ("Run").
    let confirmLabel: String
    /// Names offered as one-tap fills: you, plus anyone tagged on the match.
    let suggestions: [String]
    let onRun: (AnalysisRequest) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var trimText: String
    @State private var name1: String
    @State private var name2: String
    /// Prefill runs once, after your own name arrives from the profile cache.
    @State private var didPrefill = false

    @ObservedObject private var cache = AppCache.shared

    init(confirmLabel: String,
         suggestions: [String],
         initialPlayers: AnalysisPlayers? = nil,
         initialStartTimeSec: Double? = nil,
         onRun: @escaping (AnalysisRequest) -> Void) {
        self.confirmLabel = confirmLabel
        self.suggestions = suggestions
        self.onRun = onRun
        _name1 = State(initialValue: initialPlayers?.player1 ?? "")
        _name2 = State(initialValue: initialPlayers?.player2 ?? "")
        _trimText = State(initialValue: initialStartTimeSec.map(Self.timeText) ?? "")
    }

    /// You first — you're the one who recorded the match, so you're almost
    /// certainly in it — then whoever else is tagged, minus duplicates.
    private var allSuggestions: [String] {
        var seen = Set<String>()
        return ([cache.profile?.displayName].compactMap { $0?.nonEmpty } + suggestions)
            .compactMap { $0.nonEmpty }
            .filter { seen.insert($0.lowercased()).inserted }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("Skip warm-up to").foregroundStyle(Theme.muted)
                        Spacer()
                        TextField("0:00", text: $trimText)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numbersAndPunctuation)
                            .frame(maxWidth: 90)
                    }
                } header: {
                    Text("Match start")
                } footer: {
                    Text("Leave blank to analyse from the beginning. Set it to the first real point so knock-up rallies aren't counted as games.")
                }

                Section {
                    courtHint
                    playerField(slot: 1, label: "Player 1 — starts near", text: $name1)
                    playerField(slot: 2, label: "Player 2 — starts far", text: $name2)
                    Button {
                        let first = name1
                        name1 = name2
                        name2 = first
                    } label: {
                        Label("Swap players", systemImage: "arrow.up.arrow.down")
                            .font(.subheadline)
                    }
                } header: {
                    Text("Who's playing")
                } footer: {
                    Text("Used to label who served each game. Both are added to the match as players.")
                }
            }
            .navigationTitle("AI breakdown")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmLabel) {
                        onRun(AnalysisRequest(
                            startTimeSec: Self.parseTime(trimText),
                            players: AnalysisPlayers(player1: name1.nonEmpty, player2: name2.nonEmpty)
                        ))
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .task {
                await cache.refreshProfile()
                prefill()
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Which end of the court each slot means — the model's `player_1` is
    /// whoever starts nearest the camera, which is only obvious with the picture.
    private var courtHint: some View {
        VStack(spacing: 3) {
            Text("Far end (top of frame)").font(.caption2).foregroundStyle(Theme.muted)
            Rectangle().fill(Theme.border).frame(height: 1)
            Text("Near end (bottom of frame)").font(.caption2).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
    }

    private func playerField(slot: Int, label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle()
                    .fill(slot == 1 ? Theme.accent : Theme.sage)
                    .frame(width: 8, height: 8)
                Text(label).font(.caption).foregroundStyle(Theme.muted)
            }
            TextField("Name (optional)", text: text)
            let unused = allSuggestions.filter { !$0.equalsName(text.wrappedValue) }
            if !unused.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(unused, id: \.self) { name in
                            Button { text.wrappedValue = name } label: {
                                Text(name)
                                    .font(.caption)
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(Theme.surface2, in: Capsule())
                                    .foregroundStyle(Theme.text)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Fill empty slots from the suggestions — you in the first free slot, then
    /// whoever else is tagged — so the common case is confirm-and-go.
    private func prefill() {
        guard !didPrefill, !allSuggestions.isEmpty else { return }
        didPrefill = true
        for name in allSuggestions {
            if name.equalsName(name1) || name.equalsName(name2) { continue }
            if name1.nonEmpty == nil { name1 = name }
            else if name2.nonEmpty == nil { name2 = name }
            else { break }
        }
    }

    // MARK: Time text

    /// Parse "m:ss" or plain seconds; nil for blank or nonsense.
    nonisolated static func parseTime(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        if t.contains(":") {
            let parts = t.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let m = Double(parts[0]), let s = Double(parts[1]) else { return nil }
            let total = m * 60 + s
            return total > 0 ? total : nil
        }
        guard let n = Double(t), n > 0 else { return nil }
        return n
    }

    nonisolated static func timeText(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

extension String {
    /// Case/whitespace-insensitive display-name comparison.
    func equalsName(_ other: String) -> Bool {
        let a = trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let b = other.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !a.isEmpty && a == b
    }
}

/// Turning the two analysis labels into real match players.
///
/// Naming someone in the breakdown shelf is the clearest possible statement that
/// they played, so it tags them on the match too — linked to their account when
/// the name is yours, a guest otherwise. Existing players are matched by name and
/// kept as they are, so an already-linked account or a pending invite survives.
enum AnalysisParticipants {
    static func merged(names: [String],
                       existing: [Participant],
                       me: (id: String, name: String)?) -> [Participant] {
        var out = existing
        for name in names.compactMap({ $0.nonEmpty }) {
            guard !out.contains(where: { $0.displayName.equalsName(name) }) else { continue }
            let isMe = me.map { name.equalsName($0.name) } ?? false
            out.append(Participant(userId: isMe ? me?.id : nil, displayName: name, email: nil))
        }
        return out
    }
}
