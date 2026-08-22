import SwiftUI

/// Match comments — a flat list plus a composer. Anyone with access can comment;
/// the author or the match owner can delete. Mirrors the web `CommentSection`.
///
/// A comment can name a player with `@` and point at a moment with `12:34`; both
/// are stored in the body and rendered by `CommentText`.
struct CommentSection: View {
    let videoId: String
    /// The watch screen's player, so a timestamp in a comment can play from there.
    var onSeek: ((Double) -> Void)?
    /// Lets the caller badge the comment count without fetching the list twice.
    var onCountChange: ((Int) -> Void)?

    @State private var comments: [Comment] = []
    @State private var loading = true
    @State private var posting = false
    @State private var myId: String?
    /// A tapped @tag, pushed as a profile.
    @State private var openProfile: ProfileTarget?

    private let api = UploadAPI()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Comments").font(.headline).foregroundStyle(Theme.text)

            if loading {
                ProgressView().tint(Theme.accent)
            } else if comments.isEmpty {
                Text("No comments yet. Be the first.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            } else {
                ForEach(comments) { comment in
                    CommentRow(
                        comment: comment,
                        videoId: videoId,
                        isMine: comment.authorId != nil && comment.authorId == myId,
                        onSeek: onSeek,
                        onMention: { openProfile = .user(id: $0) },
                        onDelete: { delete(comment) },
                        onBlocked: { hideAll(from: comment.authorId) }
                    )
                }
            }

            CommentComposer(posting: posting) { body in
                await post(body)
            }
        }
        .padding(.horizontal, 16)
        .navigationDestination(item: $openProfile) { target in
            switch target {
            case .user(let id): ProfileView(userId: id)
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        myId = await Supa.currentUserId()
        comments = (try? await api.listComments(videoId: videoId)) ?? []
        onCountChange?(comments.count)
    }

    /// Blocking someone has to take their comments off the screen now, not on
    /// the next fetch — the server already filters them out from here on.
    private func hideAll(from authorId: String?) {
        guard let authorId else { return }
        comments.removeAll { $0.authorId == authorId }
        onCountChange?(comments.count)
    }

    private func post(_ body: String) async {
        posting = true
        defer { posting = false }
        if let updated = try? await api.addComment(videoId: videoId, body: body) {
            comments = updated
            onCountChange?(comments.count)
        }
    }

    private func delete(_ comment: Comment) {
        comments.removeAll { $0.id == comment.id }
        onCountChange?(comments.count)
        Task { try? await api.deleteComment(videoId: videoId, commentId: comment.id) }
    }
}

// MARK: - Composer

/// The comment box, with player tagging.
///
/// What you type is what you see: the field holds `@Ada Lovelace`, not the
/// `@[Ada Lovelace](uuid)` markup that goes to the server. The ids of everyone
/// picked are kept alongside and folded back in at post time, so the composer
/// never shows anyone a uuid they didn't write, and editing the draft afterwards
/// can't leave a half-eaten tag behind — a name that no longer appears simply
/// stops being a mention.
private struct CommentComposer: View {
    let posting: Bool
    let onPost: (String) async -> Void

    @State private var draft = ""
    @State private var picked: [UserResult] = []
    @State private var suggestions: [UserResult] = []
    @State private var searchTask: Task<Void, Never>?
    /// How tall the open suggestion list is, so it can be lifted clear of the
    /// field by exactly its own height.
    @State private var listHeight: CGFloat = 0

    private let api = UploadAPI()

    /// The `@…` being typed at the end of the draft. One space is allowed inside
    /// it so "@ada lov" can still find Ada Lovelace; two would swallow the rest
    /// of the sentence. Only people you follow are offered.
    private static let trigger = try? NSRegularExpression(
        pattern: #"@([\p{L}\p{N}'’-]{1,30}(?: [\p{L}\p{N}'’-]{1,30})?)$"#
    )

    var body: some View {
        HStack(spacing: 10) {
            TextField("Add a comment… @ to tag someone you follow", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .foregroundStyle(Theme.text)
            Button {
                Task { await submit() }
            } label: {
                Text("Post").font(.subheadline.weight(.semibold))
            }
            .disabled(posting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        // The suggestions float above the field instead of sitting in the stack
        // with it. As a sibling they pushed the field down by their own height —
        // and with the keyboard up there is nowhere for it to go, so the words
        // being typed disappeared behind the keyboard just as the list you were
        // typing at appeared. Floating leaves the field exactly where the thumb
        // left it and spends the space upwards, over the comments instead.
        //
        // Moved by a measured offset rather than an `alignmentGuide`. The guide
        // is the tidier spelling, but it has to survive the `if` below to work,
        // and it does not: inside the conditional the overlay fell back to plain
        // .top alignment and drew the list *downwards* over the field — exactly
        // the thing this is here to prevent. An offset is arithmetic on a number
        // we measured ourselves, so there is nothing left to resolve.
        .overlay(alignment: .top) {
            if !suggestions.isEmpty {
                suggestionList
                    // Measured by writing state straight from the reader rather
                    // than through a PreferenceKey: preferences set inside a
                    // `.background`/`.overlay` do not propagate to the parent, so
                    // the height never arrived and the list stayed invisible.
                    .background(
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { listHeight = geo.size.height }
                                .onChange(of: geo.size.height) { _, h in listHeight = h }
                        }
                    )
                    .offset(y: -(listHeight + 8))
                    // Hidden for the one frame between being built and being
                    // measured, so it never flashes on top of the field.
                    .opacity(listHeight > 0 ? 1 : 0)
            }
        }
        .onChange(of: draft) { _, text in search(in: text) }
    }

    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(suggestions) { user in
                Button { choose(user) } label: {
                    HStack(spacing: 10) {
                        Avatar(name: user.displayName, size: 26)
                        Text(user.displayName).font(.subheadline).foregroundStyle(Theme.text)
                        Spacer()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if user.id != suggestions.last?.id {
                    Rectangle().fill(Theme.border).frame(height: 0.5)
                }
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.border, lineWidth: 1))
        // It is floating over the comments now, so it needs to read as a layer
        // rather than as more of the page.
        .shadow(color: .black.opacity(0.45), radius: 12, y: 4)
    }

    /// The trailing `@…`, as an NSRange into the draft.
    private func triggerRange(in text: String) -> NSRange? {
        let ns = text as NSString
        guard let match = Self.trigger?.firstMatch(
            in: text, range: NSRange(location: 0, length: ns.length)
        ) else { return nil }
        return match.range
    }

    private func search(in text: String) {
        searchTask?.cancel()
        guard let range = triggerRange(in: text) else {
            suggestions = []
            return
        }
        let query = (text as NSString).substring(with: range).dropFirst()
        guard query.count >= 2 else {
            suggestions = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let found = (try? await api.searchUsers(String(query), followingOnly: true)) ?? []
            guard !Task.isCancelled else { return }
            suggestions = Array(found.prefix(5))
        }
    }

    /// Swap the `@…` at the end of the draft for the chosen player's name.
    private func choose(_ user: UserResult) {
        guard let range = triggerRange(in: draft) else { return }
        searchTask?.cancel()
        draft = (draft as NSString).replacingCharacters(in: range, with: "@\(user.displayName) ")
        if !picked.contains(where: { $0.id == user.id }) { picked.append(user) }
        suggestions = []
    }

    /// Fold the picked players back into markup. Longest name first, so tagging
    /// both "Sam" and "Sam Ellis" can't leave the longer one rewritten as the
    /// shorter one plus stray text.
    private func markup() -> String {
        var out = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        for user in picked.sorted(by: { $0.displayName.count > $1.displayName.count }) {
            out = out.replacingOccurrences(
                of: "@\(user.displayName)",
                with: CommentMarkup.markup(name: user.displayName, userId: user.id)
            )
        }
        return out
    }

    private func submit() async {
        let body = markup()
        guard !body.isEmpty else { return }
        await onPost(body)
        draft = ""
        picked = []
        suggestions = []
    }
}

// MARK: - Row

private struct CommentRow: View {
    let comment: Comment
    let videoId: String
    let isMine: Bool
    var onSeek: ((Double) -> Void)?
    var onMention: ((String) -> Void)?
    let onDelete: () -> Void
    let onBlocked: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: comment.authorName, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(comment.authorName ?? "Someone")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                    Text(parseISODate(comment.createdAt).formatted(date: .abbreviated, time: .omitted))
                        .font(.caption2).foregroundStyle(Theme.muted)
                }
                CommentText(text: comment.body, onSeek: onSeek, onMention: onMention)
            }
            Spacer()
            if comment.canDelete {
                Button(action: onDelete) {
                    Image(systemName: "trash").font(.caption).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
            }
            ModerationMenu(
                target: .comment(
                    id: comment.id,
                    videoId: videoId,
                    authorId: comment.authorId,
                    authorName: comment.authorName
                ),
                isMine: isMine,
                onBlocked: onBlocked
            )
        }
    }
}
