import SwiftUI

/// The shelf's text fields, so the sheet owns one `@FocusState` and the player
/// rows can bind into it.
enum MatchSetupFocus: Hashable { case start, nearName, nearEmail, farName, farEmail }

/// One of the two people in a match, as the shelf collects them: a linked Ojo
/// account, a guest we'll invite by email, or just a name.
struct PlayerEntry: Equatable {
    var name: String = ""
    /// Set when picked from the player dropdown — links the match to their account.
    var userId: String?
    /// Set for a guest — the server emails them an invite when the match is saved.
    var email: String?

    var isEmpty: Bool { name.nonEmpty == nil }
    var isLinked: Bool { userId != nil }

    var participant: Participant? {
        guard let name = name.nonEmpty else { return nil }
        return Participant(userId: userId, displayName: name, email: email?.nonEmpty)
    }

    init(name: String = "", userId: String? = nil, email: String? = nil) {
        self.name = name
        self.userId = userId
        self.email = email
    }

    init(_ participant: Participant) {
        name = participant.displayName
        userId = participant.userId
        email = participant.email
    }
}

/// Everything the shelf collects: when the match really starts, and who played.
struct MatchSetup: Equatable {
    var startTimeSec: Double?
    /// `player_1` in the model's vocabulary — starts nearest the camera.
    var near = PlayerEntry()
    /// `player_2` — starts at the far end.
    var far = PlayerEntry()

    var analysisPlayers: AnalysisPlayers {
        AnalysisPlayers(player1: near.name.nonEmpty, player2: far.name.nonEmpty)
    }

    var analysisRequest: AnalysisRequest {
        AnalysisRequest(startTimeSec: startTimeSec, players: analysisPlayers)
    }

    /// The two named players, plus anyone already on the match the shelf didn't
    /// touch — so tagging here never quietly drops a third person or an invite.
    func participants(mergedWith existing: [Participant]) -> [Participant] {
        var out = [near, far].compactMap(\.participant)
        for participant in existing
        where !out.contains(where: { $0.displayName.equalsName(participant.displayName) }) {
            out.append(participant)
        }
        return out
    }
}

/// The shelf behind Upload, AI Breakdown and Re-analyse: the two answers that
/// decide whether a breakdown is any use — when the knock-up ends, and who's at
/// which end — collected once and reused for the tagging on the match itself.
struct MatchSetupSheet: View {
    /// Which pair of actions the bottom of the shelf offers.
    enum Purpose {
        /// The match is still on this phone.
        case beforeUpload
        /// It's already in the cloud; the shelf is only about the breakdown.
        case cloudMatch
    }

    let purpose: Purpose
    /// Anyone already tagged on the match — offered in the dropdowns and kept.
    let existing: [Participant]
    var initialPlayers: AnalysisPlayers?
    var initialStartTimeSec: Double?
    /// The plain action: upload without a breakdown, or save the players.
    let onSecondary: (MatchSetup) -> Void
    /// The one with the sparkles on it.
    let onPrimary: (MatchSetup) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var cache = AppCache.shared

    @State private var startText: String
    @State private var near = PlayerEntry()
    @State private var far = PlayerEntry()
    @State private var didPrefill = false
    @FocusState private var focus: MatchSetupFocus?

    init(purpose: Purpose,
         existing: [Participant],
         initialPlayers: AnalysisPlayers? = nil,
         initialStartTimeSec: Double? = nil,
         onSecondary: @escaping (MatchSetup) -> Void,
         onPrimary: @escaping (MatchSetup) -> Void) {
        self.purpose = purpose
        self.existing = existing
        self.initialPlayers = initialPlayers
        self.initialStartTimeSec = initialStartTimeSec
        self.onSecondary = onSecondary
        self.onPrimary = onPrimary
        _startText = State(initialValue: initialStartTimeSec.map(Self.timeText) ?? "")
    }

    private var setup: MatchSetup {
        MatchSetup(startTimeSec: Self.parseTime(startText), near: near, far: far)
    }

    /// You, then anyone already tagged — the people most likely to be on court.
    private var knownPlayers: [PlayerEntry] {
        var out: [PlayerEntry] = []
        if let profile = cache.profile, let name = profile.displayName.nonEmpty {
            out.append(PlayerEntry(name: name, userId: profile.id))
        }
        for participant in existing
        where !out.contains(where: { $0.name.equalsName(participant.displayName) }) {
            out.append(PlayerEntry(participant))
        }
        return out
    }

    var body: some View {
        NavigationStack {
            Form {
                startSection
                playersSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(purpose == .beforeUpload ? "Set up this match" : "AI breakdown")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .keyboard) {
                    Button("Done") { focus = nil }
                }
            }
            .safeAreaInset(edge: .bottom) { actions }
            .task {
                await cache.refreshProfile()
                prefill()
            }
        }
        .presentationDetents([.large])
    }

    // MARK: Sections

    private var startSection: some View {
        Section {
            HStack {
                Text("Skip warm-up to").foregroundStyle(Theme.muted)
                Spacer()
                TextField("0:00", text: $startText)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.numbersAndPunctuation)
                    .focused($focus, equals: .start)
                    .frame(maxWidth: 90)
            }
        } header: {
            Text("Match start")
        } footer: {
            Text("Leave blank to analyse from the beginning. Set it to the first real point so knock-up rallies aren't counted as games.")
        }
    }

    private var playersSection: some View {
        Section {
            courtHint
            PlayerField(
                label: "Player 1 — starts near",
                dot: Theme.accent,
                entry: $near,
                known: knownPlayers.filter { !$0.name.equalsName(far.name) },
                nameFocus: $focus,
                nameTarget: .nearName,
                emailTarget: .nearEmail
            )
            PlayerField(
                label: "Player 2 — starts far",
                dot: Theme.sage,
                entry: $far,
                known: knownPlayers.filter { !$0.name.equalsName(near.name) },
                nameFocus: $focus,
                nameTarget: .farName,
                emailTarget: .farEmail
            )
            Button {
                let first = near
                near = far
                far = first
            } label: {
                Label("Swap ends", systemImage: "arrow.up.arrow.down").font(.subheadline)
            }
        } header: {
            Text("Who's playing")
        } footer: {
            Text("Search to tag someone on Ojo, or type a name and add their email to invite them. Both are added to the match as players.")
        }
    }

    /// Which end of the court each slot means — `player_1` is whoever starts
    /// nearest the camera, which is only obvious with the picture in front of you.
    private var courtHint: some View {
        VStack(spacing: 3) {
            Text("Far end (top of frame)").font(.caption2).foregroundStyle(Theme.muted)
            Rectangle().fill(Theme.border).frame(height: 1)
            Text("Near end (bottom of frame)").font(.caption2).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
    }

    // MARK: Actions

    private var actions: some View {
        VStack(spacing: 8) {
            Button {
                onPrimary(setup)
                dismiss()
            } label: {
                Label(primaryTitle, systemImage: "sparkles")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                    .foregroundStyle(Theme.text)
            }
            Button {
                onSecondary(setup)
                dismiss()
            } label: {
                Text(secondaryTitle)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .stroke(Theme.border, lineWidth: 1.5))
                    .foregroundStyle(Theme.text)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private var primaryTitle: String {
        purpose == .beforeUpload ? "Upload & AI Breakdown" : "Run AI Breakdown"
    }

    private var secondaryTitle: String {
        purpose == .beforeUpload ? "Upload" : "Save players"
    }

    /// Fill empty slots from the known players — you in the first free one — so
    /// the common case is confirm-and-go.
    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        if let player1 = initialPlayers?.player1?.nonEmpty {
            near = entry(named: player1)
        }
        if let player2 = initialPlayers?.player2?.nonEmpty {
            far = entry(named: player2)
        }
        for candidate in knownPlayers {
            if candidate.name.equalsName(near.name) || candidate.name.equalsName(far.name) { continue }
            if near.isEmpty { near = candidate } else if far.isEmpty { far = candidate } else { break }
        }
    }

    /// Match a stored analysis name back to a known player, so a re-run keeps the
    /// account link instead of degrading it to a bare name.
    private func entry(named name: String) -> PlayerEntry {
        knownPlayers.first { $0.name.equalsName(name) } ?? PlayerEntry(name: name)
    }

    // MARK: Time text

    /// Parse "m:ss" or plain seconds; nil for blank or nonsense.
    nonisolated static func parseTime(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains(":") {
            let parts = trimmed.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let minutes = Double(parts[0]), let seconds = Double(parts[1])
            else { return nil }
            let total = minutes * 60 + seconds
            return total > 0 ? total : nil
        }
        guard let seconds = Double(trimmed), seconds > 0 else { return nil }
        return seconds
    }

    nonisolated static func timeText(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Player field

/// A name field with a live dropdown: you and anyone already tagged, then Ojo
/// players matching what's typed, then the option to keep it as a guest — with an
/// email box so they get invited rather than just written down.
private struct PlayerField: View {
    let label: String
    let dot: Color
    @Binding var entry: PlayerEntry
    let known: [PlayerEntry]
    @FocusState.Binding var nameFocus: MatchSetupFocus?
    let nameTarget: MatchSetupFocus
    let emailTarget: MatchSetupFocus

    @State private var results: [UserResult] = []
    @State private var searchTask: Task<Void, Never>?

    private let api = UploadAPI()

    /// Known players still worth offering for what's been typed so far.
    private var matchingKnown: [PlayerEntry] {
        guard let typed = entry.name.nonEmpty?.lowercased() else { return known }
        return known.filter { $0.name.lowercased().contains(typed) && !$0.name.equalsName(entry.name) }
    }

    /// Search hits that aren't already offered above.
    private var matchingUsers: [UserResult] {
        results.filter { result in
            !known.contains { $0.userId == result.id } && !result.displayName.equalsName(entry.name)
        }
    }

    private var showsDropdown: Bool {
        nameFocus == nameTarget && !(matchingKnown.isEmpty && matchingUsers.isEmpty)
    }

    /// A guest — named, but not an Ojo account — is the only case an invite helps.
    private var showsEmail: Bool {
        !entry.isEmpty && !entry.isLinked
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(label).font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                if entry.isLinked {
                    Badge(text: "OJO", tone: Theme.sage)
                } else if entry.email?.nonEmpty != nil {
                    Badge(text: "INVITE", tone: Theme.accent)
                }
            }

            HStack(spacing: 8) {
                // A custom binding rather than `onChange`, because only a *typed*
                // edit should break the link to an account. onChange can't tell
                // typing from picking a name out of the dropdown, so it would
                // un-link the very account you'd just chosen.
                TextField("Search players or type a name", text: Binding(
                    get: { entry.name },
                    set: { typed in
                        entry.name = typed
                        entry.userId = nil
                        search(typed)
                    }
                ))
                    .focused($nameFocus, equals: nameTarget)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                if !entry.isEmpty {
                    Button {
                        entry = PlayerEntry()
                        results = []
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear \(label)")
                }
            }

            if showsDropdown { dropdown }

            if showsEmail {
                TextField("Email (optional — sends them an invite)",
                          text: Binding(get: { entry.email ?? "" },
                                        set: { entry.email = $0.nonEmpty }))
                    .focused($nameFocus, equals: emailTarget)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
            }
        }
        .padding(.vertical, 4)
        .onDisappear { searchTask?.cancel() }
    }

    private var dropdown: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(matchingKnown, id: \.name) { candidate in
                row(name: candidate.name, subtitle: candidate.isLinked ? "On Ojo" : "Guest") {
                    entry = candidate
                }
            }
            ForEach(matchingUsers) { user in
                row(name: user.displayName, subtitle: "On Ojo") {
                    entry = PlayerEntry(name: user.displayName, userId: user.id)
                }
            }
        }
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
    }

    private func row(name: String, subtitle: String, select: @escaping () -> Void) -> some View {
        Button {
            select()
            results = []
            nameFocus = nil
        } label: {
            HStack(spacing: 10) {
                Avatar(name: name, size: 26)
                Text(name).font(.subheadline).foregroundStyle(Theme.text)
                Spacer()
                Text(subtitle).font(.caption2).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Debounced so a name typed at speed is one request, not eight.
    private func search(_ query: String) {
        searchTask?.cancel()
        guard query.trimmingCharacters(in: .whitespaces).count >= 2 else {
            results = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let found = (try? await api.searchUsers(query)) ?? []
            guard !Task.isCancelled else { return }
            results = found
        }
    }
}

private struct Badge: View {
    let text: String
    let tone: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .tracking(0.5)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tone.opacity(0.18), in: Capsule())
            .foregroundStyle(tone)
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
