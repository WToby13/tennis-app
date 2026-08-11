import SwiftUI

/// The shelf's text fields, so the sheet owns one `@FocusState` and the person
/// rows can bind into it.
enum MatchSetupFocus: Hashable { case title, start, near, far, share }

/// Someone attached to a match, as the shelf collects them: a linked Ojo account,
/// an email invite, or just a name.
struct PlayerEntry: Identifiable {
    var id = UUID()
    var name: String = ""
    /// Set when picked from the dropdown — links the match to their account.
    var userId: String?
    /// Set when added by email — the server invites them when the match is saved.
    var email: String?

    var isEmpty: Bool { name.nonEmpty == nil }
    var isLinked: Bool { userId != nil }
    var isInvite: Bool { userId == nil && email?.nonEmpty != nil }

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

    /// An email invite. The address is kept for the invite, but the *name* is its
    /// local part — "ada" reads better than "ada@example.com" everywhere the
    /// match shows who played, and the two are relinked when they sign up.
    static func invite(email: String) -> PlayerEntry {
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        let local = address.split(separator: "@").first.map(String.init) ?? address
        return PlayerEntry(name: local.capitalized, email: address)
    }
}

/// The match the shelf is opened on — what it's called and the facts about the
/// file, shown so you can tell one untitled match from another.
struct MatchSubject {
    var title: String
    var createdAt: Date
    var durationS: Double
    var sizeBytes: Int

    /// Date, time, length, size on one muted line.
    var detailLine: String {
        var parts = [
            createdAt.formatted(date: .abbreviated, time: .omitted),
            createdAt.formatted(date: .omitted, time: .shortened),
        ]
        if durationS > 0 { parts.append(durationString(durationS)) }
        if sizeBytes > 0 { parts.append(sizeString(sizeBytes)) }
        return parts.joined(separator: " · ")
    }
}

/// Everything the shelf collects: what the match is called, when it really
/// starts, and who's on it.
struct MatchSetup {
    var title: String?
    var startTimeSec: Double?
    /// `player_1` in the model's vocabulary — starts nearest the camera.
    var near = PlayerEntry()
    /// `player_2` — starts at the far end.
    var far = PlayerEntry()
    /// Anyone else the match should be shared with.
    var others: [PlayerEntry] = []

    var analysisPlayers: AnalysisPlayers {
        AnalysisPlayers(player1: near.name.nonEmpty, player2: far.name.nonEmpty)
    }

    var analysisRequest: AnalysisRequest {
        AnalysisRequest(startTimeSec: startTimeSec, players: analysisPlayers)
    }

    /// Everyone the shelf named, plus anyone already on the match it didn't touch —
    /// so tagging here never quietly drops a third person or a pending invite.
    func participants(mergedWith existing: [Participant]) -> [Participant] {
        var out = ([near, far] + others).compactMap(\.participant)
        for participant in existing
        where !out.contains(where: { $0.displayName.equalsName(participant.displayName) }) {
            out.append(participant)
        }
        return out
    }
}

/// The shelf behind Upload, AI Breakdown and Re-analyse: when the knock-up ends,
/// who's at which end, and who else should see it. Collected once, then reused as
/// the match's player tags and the breakdown's inputs.
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
    /// The match itself: its name and file facts. Absent only if the caller has
    /// nothing to show yet.
    var subject: MatchSubject?
    var initialPlayers: AnalysisPlayers?
    var initialStartTimeSec: Double?
    /// Resolves what to hand the system share sheet — a share link for a match
    /// that's in the cloud, the video file for one that isn't.
    var shareURL: (() async -> URL?)?
    /// Absent when the match isn't yours to delete.
    var onDelete: (() -> Void)?
    /// The plain action: upload without a breakdown, or save the players.
    let onSecondary: (MatchSetup) -> Void
    /// The one with the sparkles on it.
    let onPrimary: (MatchSetup) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var cache = AppCache.shared

    @State private var startText: String
    @State private var titleText: String
    @State private var near = PlayerEntry()
    @State private var far = PlayerEntry()
    @State private var others: [PlayerEntry] = []
    @State private var shareDraft = PlayerEntry()
    @State private var didPrefill = false
    @State private var confirmingDelete = false
    @State private var sharePayload: SharePayload?
    @State private var preparingShare = false
    @FocusState private var focus: MatchSetupFocus?

    init(purpose: Purpose,
         existing: [Participant],
         subject: MatchSubject? = nil,
         initialPlayers: AnalysisPlayers? = nil,
         initialStartTimeSec: Double? = nil,
         shareURL: (() async -> URL?)? = nil,
         onDelete: (() -> Void)? = nil,
         onSecondary: @escaping (MatchSetup) -> Void,
         onPrimary: @escaping (MatchSetup) -> Void) {
        self.purpose = purpose
        self.existing = existing
        self.subject = subject
        self.initialPlayers = initialPlayers
        self.initialStartTimeSec = initialStartTimeSec
        self.shareURL = shareURL
        self.onDelete = onDelete
        self.onSecondary = onSecondary
        self.onPrimary = onPrimary
        _startText = State(initialValue: initialStartTimeSec.map(Self.timeText) ?? "")
        _titleText = State(initialValue: subject?.title ?? "")
    }

    private var setup: MatchSetup {
        MatchSetup(title: titleText.nonEmpty,
                   startTimeSec: Self.parseTime(startText),
                   near: near, far: far, others: others)
    }

    /// You, then anyone already tagged — the people most likely to be involved.
    private var knownPeople: [PlayerEntry] {
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

    /// Names spoken for elsewhere in the sheet, so nobody is offered twice.
    private func taken(excluding slot: MatchSetupFocus) -> [String] {
        var names = others.map(\.name)
        if slot != .near { names.append(near.name) }
        if slot != .far { names.append(far.name) }
        return names.filter { !$0.isEmpty }
    }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                startSection
                playersSection
                shareSection
                actions
                manageSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(purpose == .beforeUpload ? "Set up this match" : "AI breakdown")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                // Trailing, so dismissing the keyboard is under the thumb that's
                // already typing.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focus = nil }.fontWeight(.semibold)
                }
            }
            .task {
                await cache.refreshProfile()
                prefill()
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(url: payload.url)
            }
        }
        .presentationDetents([.large])
        .overlay {
            if confirmingDelete {
                OjoConfirm(
                    title: "Are you sure?",
                    message: "This can not be undone.",
                    onConfirm: {
                        // Close the shelf first: deleting can pop the screen
                        // underneath it, and a sheet outliving its host is how
                        // you get a stuck, undismissable overlay.
                        confirmingDelete = false
                        dismiss()
                        onDelete?()
                    },
                    onCancel: { confirmingDelete = false }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: confirmingDelete)
    }

    // MARK: Sections

    private var nameSection: some View {
        Section {
            TextField("Untitled match", text: $titleText)
                .focused($focus, equals: .title)
                .submitLabel(.done)
        } header: {
            Text("Recording name")
        } footer: {
            if let subject {
                Text(subject.detailLine)
            }
        }
    }

    private var startSection: some View {
        Section {
            HStack {
                Text("First point starts at").foregroundStyle(Theme.muted)
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
            Text("Leave blank to analyse from the beginning.")
        }
    }

    private var playersSection: some View {
        Section {
            PersonField(
                label: "Player 1 — starts near side (bottom)",
                dot: Theme.accent,
                entry: $near,
                known: knownPeople,
                taken: taken(excluding: .near),
                focus: $focus,
                target: .near
            )
            PersonField(
                label: "Player 2 — starts far side (top)",
                dot: Theme.sage,
                entry: $far,
                known: knownPeople,
                taken: taken(excluding: .far),
                focus: $focus,
                target: .far
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
            Text("Used to label who served each game. Both are added to the match as players.")
        }
    }

    private var shareSection: some View {
        Section {
            ForEach(others) { person in
                HStack(spacing: 10) {
                    Avatar(name: person.name, size: 26)
                    Text(person.name).font(.subheadline).foregroundStyle(Theme.text)
                    if person.isLinked {
                        Badge(text: "OJO", tone: Theme.sage)
                    } else if person.isInvite {
                        Badge(text: "INVITE", tone: Theme.accent)
                    }
                    Spacer()
                    Button {
                        others.removeAll { $0.id == person.id }
                    } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(Theme.danger)
                    }
                    .buttonStyle(.borderless)
                }
            }
            PersonField(
                label: nil,
                dot: nil,
                entry: $shareDraft,
                known: knownPeople,
                taken: taken(excluding: .share),
                focus: $focus,
                target: .share,
                // The share field is a queue, not a slot: each pick is appended
                // and the field clears itself, ready for the next person.
                onCommit: { person in
                    others.append(person)
                    shareDraft = PlayerEntry()
                }
            )
        } header: {
            Text("Share with more")
        } footer: {
            Text("They'll see the match in their library. New users will get an invite to Ojo via email.")
        }
    }

    // MARK: Actions

    /// The last thing in the sheet, scrolling with everything else. Pinning it
    /// meant the keyboard shoved it up into the middle of the screen; down here it
    /// simply sits under the last question, which is where you're finished anyway.
    private var actions: some View {
        Section {
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
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)
        }
    }

    /// Sharing and deleting: the two things you do to a match that aren't about
    /// getting it analysed, kept below the actions and out of the way.
    @ViewBuilder private var manageSection: some View {
        if shareURL != nil || onDelete != nil {
            Section {
                if shareURL != nil {
                    Button(action: share) {
                        HStack {
                            Label("Share", systemImage: "square.and.arrow.up")
                                .foregroundStyle(Theme.text)
                            Spacer()
                            if preparingShare { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(preparingShare)
                }
                if onDelete != nil {
                    Button(role: .destructive) {
                        focus = nil
                        confirmingDelete = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
    }

    /// Resolve what to share (which may need a round trip to mint a link), then
    /// hand it to the system sheet.
    private func share() {
        guard let shareURL, !preparingShare else { return }
        preparingShare = true
        Task {
            defer { preparingShare = false }
            if let url = await shareURL() {
                sharePayload = SharePayload(url: url)
            }
        }
    }

    private var primaryTitle: String {
        purpose == .beforeUpload ? "Upload & AI Breakdown" : "Run AI Breakdown"
    }

    private var secondaryTitle: String {
        purpose == .beforeUpload ? "Upload" : "Save players"
    }

    /// Fill empty slots from the known people — you in the first free one — so
    /// the common case is confirm-and-go.
    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        if let player1 = initialPlayers?.player1?.nonEmpty { near = entry(named: player1) }
        if let player2 = initialPlayers?.player2?.nonEmpty { far = entry(named: player2) }
        for candidate in knownPeople {
            if candidate.name.equalsName(near.name) || candidate.name.equalsName(far.name) { continue }
            if near.isEmpty { near = candidate } else if far.isEmpty { far = candidate } else { break }
        }
    }

    /// Match a stored analysis name back to a known person, so a re-run keeps the
    /// account link instead of degrading it to a bare name.
    private func entry(named name: String) -> PlayerEntry {
        knownPeople.first { $0.name.equalsName(name) } ?? PlayerEntry(name: name)
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

// MARK: - Person field

/// One name field with a live dropdown: you and anyone already on the match, then
/// Ojo players matching what's typed, then — if it looks like an address — the
/// option to invite by email. The single field covers all three, so there's one
/// place to put a person no matter how you know them.
private struct PersonField: View {
    var label: String?
    var dot: Color?
    @Binding var entry: PlayerEntry
    let known: [PlayerEntry]
    /// Names already used elsewhere in the sheet.
    let taken: [String]
    @FocusState.Binding var focus: MatchSetupFocus?
    let target: MatchSetupFocus
    /// When present, picking someone hands them over instead of filling this
    /// field — how "Share with more" collects a list.
    var onCommit: ((PlayerEntry) -> Void)?

    @State private var results: [UserResult] = []
    @State private var searching = false
    @State private var searchTask: Task<Void, Never>?

    private let api = UploadAPI()

    private var typed: String { entry.name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func isFree(_ name: String) -> Bool {
        !taken.contains { $0.equalsName(name) }
    }

    /// Known people worth offering: everyone free, narrowed by what's typed.
    private var suggestions: [PlayerEntry] {
        known.filter { candidate in
            guard isFree(candidate.name) else { return false }
            guard !typed.isEmpty else { return true }
            return candidate.name.localizedCaseInsensitiveContains(typed)
                && !candidate.name.equalsName(typed)
        }
    }

    /// Search hits not already offered above.
    private var found: [UserResult] {
        results.filter { result in
            isFree(result.displayName)
                && !known.contains { $0.userId == result.id }
                && !result.displayName.equalsName(typed)
        }
    }

    /// Typing an address is an invite — the only way to add someone who has no
    /// account to match against.
    private var inviteCandidate: PlayerEntry? {
        guard typed.looksLikeEmail, isFree(typed) else { return nil }
        return PlayerEntry.invite(email: typed)
    }

    /// For the share field only: a plain name with nothing to match is still a
    /// person, so offer to add them as a guest.
    private var guestCandidate: PlayerEntry? {
        guard onCommit != nil, !typed.isEmpty, !typed.looksLikeEmail, isFree(typed) else { return nil }
        return PlayerEntry(name: typed)
    }

    private var showsDropdown: Bool {
        focus == target
            && !(suggestions.isEmpty && found.isEmpty
                 && inviteCandidate == nil && guestCandidate == nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let label {
                HStack(spacing: 8) {
                    if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
                    Text(label).font(.caption).foregroundStyle(Theme.muted)
                    Spacer()
                    if entry.isLinked {
                        Badge(text: "OJO", tone: Theme.sage)
                    } else if entry.isInvite {
                        Badge(text: "INVITE", tone: Theme.accent)
                    }
                }
            }

            HStack(spacing: 8) {
                // A custom binding rather than `onChange`, because only a *typed*
                // edit should break the link to an account. onChange can't tell
                // typing from picking a name out of the dropdown, so it would
                // un-link the very account you'd just chosen.
                TextField("Search players or invite by email", text: Binding(
                    get: { entry.name },
                    set: { newValue in
                        entry.name = newValue
                        entry.userId = nil
                        entry.email = nil
                        search(newValue)
                    }
                ))
                .focused($focus, equals: target)
                // Names are the common case, so capitalize them; an address typed
                // here comes out as "Ada@Example.com" and is normalised on commit
                // rather than making every name start lowercase.
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(onCommit != nil ? .done : .next)
                .onSubmit(commitTyped)

                if searching {
                    ProgressView().controlSize(.small)
                } else if !entry.isEmpty {
                    Button {
                        entry = PlayerEntry()
                        results = []
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
                }
            }

            if showsDropdown { dropdown }
        }
        .padding(.vertical, 4)
        .onDisappear { searchTask?.cancel() }
    }

    private var dropdown: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(suggestions) { candidate in
                row(name: candidate.name,
                    detail: candidate.isLinked ? "On Ojo" : "Guest",
                    icon: nil) { choose(candidate) }
            }
            ForEach(found) { user in
                row(name: user.displayName, detail: "On Ojo", icon: nil) {
                    choose(PlayerEntry(name: user.displayName, userId: user.id))
                }
            }
            if let invite = inviteCandidate {
                row(name: typed, detail: "Invite by email", icon: "envelope") { choose(invite) }
            }
            if let guest = guestCandidate {
                row(name: typed, detail: "Add as guest", icon: "person.badge.plus") { choose(guest) }
            }
        }
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
    }

    private func row(name: String, detail: String, icon: String?,
                     select: @escaping () -> Void) -> some View {
        Button(action: select) {
            HStack(spacing: 10) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.accent)
                        .frame(width: 26, height: 26)
                } else {
                    Avatar(name: name, size: 26)
                }
                Text(name).font(.subheadline).foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                Text(detail).font(.caption2).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ person: PlayerEntry) {
        results = []
        if let onCommit {
            onCommit(person)
            // Stay put: adding one person usually means adding another.
        } else {
            entry = person
            focus = nil
        }
    }

    /// Return key: take whatever's typed at face value.
    private func commitTyped() {
        guard !typed.isEmpty else { return }
        choose(inviteCandidate ?? guestCandidate ?? PlayerEntry(name: typed))
    }

    /// Debounced so a name typed at speed is one request, not eight.
    private func search(_ query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, !trimmed.looksLikeEmail else {
            results = []
            searching = false
            return
        }
        searching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let hits = (try? await api.searchUsers(trimmed)) ?? []
            guard !Task.isCancelled else { return }
            results = hits
            searching = false
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

    /// Good enough to decide whether to offer an invite — the server and the
    /// mail provider do the real validation.
    var looksLikeEmail: Bool {
        let text = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.contains(" "), text.count >= 5 else { return false }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1]
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
    }
}
