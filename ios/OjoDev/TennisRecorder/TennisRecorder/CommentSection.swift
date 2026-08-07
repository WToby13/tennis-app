import SwiftUI

/// Match comments — a flat list plus a composer. Anyone with access can comment;
/// the author or the match owner can delete. Mirrors the web `CommentSection`.
struct CommentSection: View {
    let videoId: String

    @State private var comments: [Comment] = []
    @State private var draft = ""
    @State private var loading = true
    @State private var posting = false

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
                    CommentRow(comment: comment) { delete(comment) }
                }
            }

            composer
        }
        .padding(.horizontal, 16)
        .task { await load() }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Add a comment…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .foregroundStyle(Theme.text)
            Button {
                post()
            } label: {
                Text("Post").font(.subheadline.weight(.semibold))
            }
            .disabled(posting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        comments = (try? await api.listComments(videoId: videoId)) ?? []
    }

    private func post() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        posting = true
        Task {
            defer { posting = false }
            if let updated = try? await api.addComment(videoId: videoId, body: text) {
                comments = updated
                draft = ""
            }
        }
    }

    private func delete(_ comment: Comment) {
        comments.removeAll { $0.id == comment.id }
        Task { try? await api.deleteComment(videoId: videoId, commentId: comment.id) }
    }
}

private struct CommentRow: View {
    let comment: Comment
    let onDelete: () -> Void

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
                Text(comment.body).font(.subheadline).foregroundStyle(Theme.text)
            }
            Spacer()
            if comment.canDelete {
                Button(action: onDelete) {
                    Image(systemName: "trash").font(.caption).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
