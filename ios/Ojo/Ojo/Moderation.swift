import SwiftUI

/// Reporting and blocking, in the two shapes the rest of the app needs: a menu
/// you can hang off any piece of someone else's content, and the sheet that menu
/// opens.
///
/// App Store Review Guideline 1.2 requires both on an app carrying
/// user-generated content — a way to flag content, and a way to stop seeing the
/// person who posted it. Reviewers look for them on *every* surface where
/// someone else's content appears, so this lives in one place and gets attached
/// to the feed card, the watch screen and each comment rather than being built
/// three times.

/// What is being reported. Carries everything `/api/reports` needs.
struct ReportTarget: Identifiable, Equatable {
    enum Kind: String {
        case match
        case comment
    }

    let kind: Kind
    /// Match id, or comment id.
    let id: String
    /// The match a reported comment sits on — the server needs it to find the row.
    let videoId: String?
    /// Who posted it, so the menu can offer to block them. Nil if unknown.
    let authorId: String?
    let authorName: String?

    static func match(id: String, authorId: String?, authorName: String?) -> ReportTarget {
        ReportTarget(kind: .match, id: id, videoId: nil, authorId: authorId, authorName: authorName)
    }

    static func comment(id: String, videoId: String, authorId: String?, authorName: String?) -> ReportTarget {
        ReportTarget(kind: .comment, id: id, videoId: videoId, authorId: authorId, authorName: authorName)
    }
}

// MARK: - The menu

/// "Report" / "Block" for a piece of content that isn't yours.
///
/// Renders nothing at all when the content *is* yours: offering to report
/// yourself is noise, and there is no requirement to.
struct ModerationMenu: View {
    let target: ReportTarget
    /// Set when the signed-in user posted this — the menu then hides itself.
    var isMine: Bool = false
    /// Called after a successful block, so the host can drop the content from view.
    var onBlocked: (() -> Void)? = nil

    @State private var reporting: ReportTarget?
    @State private var confirmingBlock = false
    @State private var blockError: String?

    private let api = UploadAPI()

    var body: some View {
        if !isMine {
            Menu {
                Button {
                    reporting = target
                } label: {
                    Label("Report", systemImage: "flag")
                }
                if target.authorId != nil {
                    Button(role: .destructive) {
                        confirmingBlock = true
                    } label: {
                        Label("Block \(target.authorName ?? "this player")", systemImage: "hand.raised")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .frame(width: 30, height: 30) // a real 30pt tap target, not just the glyph
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More options")
            .sheet(item: $reporting) { ReportSheet(target: $0) }
            .confirmationDialog(
                "Block \(target.authorName ?? "this player")?",
                isPresented: $confirmingBlock,
                titleVisibility: .visible
            ) {
                Button("Block", role: .destructive) { block() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You won't see their matches or comments, and they won't see yours. They aren't told.")
            }
            .alert("Couldn't block", isPresented: .constant(blockError != nil)) {
                Button("OK") { blockError = nil }
            } message: {
                Text(blockError ?? "")
            }
        }
    }

    private func block() {
        guard let userId = target.authorId else { return }
        Task {
            do {
                _ = try await api.setBlocked(userId: userId, blocked: true)
                onBlocked?()
            } catch {
                blockError = "Try again in a moment."
            }
        }
    }
}

// MARK: - The report sheet

/// Pick a reason, optionally say more, send. Deliberately short: a report form
/// that takes effort is a report that doesn't get filed.
struct ReportSheet: View {
    let target: ReportTarget

    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason = .abuse
    @State private var details = ""
    @State private var sending = false
    @State private var sent = false
    @State private var error: String?

    private let api = UploadAPI()

    var body: some View {
        NavigationStack {
            Form {
                if sent {
                    Section {
                        Label("Report sent", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Theme.sage)
                        Text("We review every report within 24 hours and remove anything that breaks our rules.")
                            .font(.footnote).foregroundStyle(Theme.muted)
                    }
                } else {
                    Section("What's wrong with this \(target.kind.rawValue)?") {
                        Picker("Reason", selection: $reason) {
                            ForEach(ReportReason.allCases) { r in
                                Text(r.label).tag(r)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section("Anything else? (optional)") {
                        TextField("Add detail", text: $details, axis: .vertical)
                            .lineLimit(3...6)
                    }
                    if let error {
                        Section {
                            Text(error).font(.footnote).foregroundStyle(Theme.danger)
                        }
                    }
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(sent ? "Done" : "Cancel") { dismiss() }
                }
                if !sent {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") { send() }.disabled(sending)
                    }
                }
            }
        }
    }

    private func send() {
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                try await api.report(
                    targetKind: target.kind.rawValue,
                    targetId: target.id,
                    videoId: target.videoId,
                    reason: reason,
                    details: details.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                sent = true
            } catch {
                self.error = "Couldn't send that. Try again in a moment."
            }
        }
    }
}

// MARK: - Blocked accounts

/// The list of people you've blocked, with a way to undo it. Reachable from
/// Settings — Apple expects a block to be reversible by the person who made it.
struct BlockedAccountsView: View {
    @State private var blocked: [ProfileSummary] = []
    @State private var loading = true

    private let api = UploadAPI()

    var body: some View {
        List {
            if loading {
                ProgressView().tint(Theme.accent)
            } else if blocked.isEmpty {
                Text("You haven't blocked anyone.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            } else {
                ForEach(blocked, id: \.id) { player in
                    HStack {
                        Avatar(name: player.displayName, size: 30)
                        Text(player.displayName).foregroundStyle(Theme.text)
                        Spacer()
                        Button("Unblock") { unblock(player) }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
            }
        }
        .navigationTitle("Blocked accounts")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        blocked = (try? await api.listBlocked()) ?? []
    }

    private func unblock(_ player: ProfileSummary) {
        blocked.removeAll { $0.id == player.id }
        Task { _ = try? await api.setBlocked(userId: player.id, blocked: false) }
    }
}
