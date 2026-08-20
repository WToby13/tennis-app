import SwiftUI
import UIKit

/// A feed card — author header, 16:9 poster that opens the match, and an action
/// row (like / comment / share / save) with like count and caption. Mirrors the
/// web `FeedCard`.
struct FeedCardView: View {
    let item: FeedItem

    @State private var liked: Bool
    @State private var likeCount: Int
    @State private var saved: Bool
    @State private var working = false
    @State private var myId: String?
    /// Set once the poster is blocked, so the card leaves the feed immediately
    /// rather than lingering until the next refresh.
    @State private var hidden = false

    private let api = UploadAPI()

    init(item: FeedItem) {
        self.item = item
        _liked = State(initialValue: item.likedByMe)
        _likeCount = State(initialValue: item.likeCount)
        _saved = State(initialValue: item.inLibrary)
    }

    var body: some View {
        if hidden {
            EmptyView()
        } else {
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            authorHeader
            NavigationLink(value: WatchTarget.video(id: item.id)) {
                RemoteThumbnail(urlString: item.thumbnailUrl)
            }
            .buttonStyle(.plain)
            actionRow
            if likeCount > 0 {
                Text(likeCount == 1 ? "1 like" : "\(likeCount) likes")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 14)
                    .padding(.top, 2)
            }
            caption
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 0.5))
        .padding(.horizontal, 12)
        .task { myId = await Supa.currentUserId() }
    }

    // MARK: Header

    private var authorHeader: some View {
        HStack(spacing: 10) {
            Avatar(name: item.authorName, size: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.authorName ?? "Someone")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                if let sharer = item.sharedByName {
                    Text("shared by \(sharer)")
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            ModerationMenu(
                target: .match(id: item.id, authorId: item.ownerId, authorName: item.authorName),
                isMine: item.ownerId != nil && item.ownerId == myId,
                onBlocked: { hidden = true }
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: Actions

    private var actionRow: some View {
        HStack(spacing: 18) {
            Button { toggleLike() } label: {
                Image(systemName: liked ? "heart.fill" : "heart")
                    .foregroundStyle(liked ? Theme.danger : Theme.text)
            }
            NavigationLink(value: WatchTarget.video(id: item.id)) {
                Image(systemName: "bubble.right")
                    .foregroundStyle(Theme.text)
            }
            Button { share() } label: {
                Image(systemName: "square.and.arrow.up").foregroundStyle(Theme.text)
            }
            Spacer()
            Button { save() } label: {
                Image(systemName: saved ? "bookmark.fill" : "bookmark")
                    .foregroundStyle(saved ? Theme.accent : Theme.text)
            }
        }
        .font(.system(size: 20, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: Caption

    private var caption: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
            Text(metaLine).font(.caption).foregroundStyle(Theme.muted)
            if item.commentCount > 0 {
                NavigationLink(value: WatchTarget.video(id: item.id)) {
                    Text(item.commentCount == 1 ? "View 1 comment" : "View all \(item.commentCount) comments")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                .padding(.top, 1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 2)
        .padding(.bottom, 14)
    }

    private var metaLine: String {
        var parts: [String] = []
        if let p = item.participantNames, !p.isEmpty { parts.append(p) }
        parts.append(parseISODate(item.createdAt).formatted(date: .abbreviated, time: .omitted))
        if let d = item.durationS, d > 0 { parts.append(durationString(d)) }
        return parts.joined(separator: " · ")
    }

    // MARK: Actions impl (optimistic)

    private func toggleLike() {
        let newLiked = !liked
        liked = newLiked
        likeCount = max(0, likeCount + (newLiked ? 1 : -1))
        Task {
            if let state = try? await api.setLike(videoId: item.id, liked: newLiked) {
                liked = state.likedByMe
                likeCount = state.count
            }
        }
    }

    private func save() {
        guard !saved else { return }
        saved = true
        Task { _ = try? await api.saveToLibrary(videoId: item.id) }
    }

    private func share() {
        guard !working else { return }
        working = true
        Task {
            defer { working = false }
            if let link = try? await api.createShareLink(videoId: item.id) {
                await MainActor.run {
                    UIPasteboard.general.string = Config.apiBaseURL.absoluteString + link.path
                }
            }
        }
    }
}

/// A 16:9 remote poster (from a signed thumbnail URL) with a play badge. Used by
/// the feed and profiles (distinct from `RecordingThumbnail`, which draws local
/// poster frames).
struct RemoteThumbnail: View {
    let urlString: String?

    var body: some View {
        ZStack {
            Color.black
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.black
                }
            }
            Image(systemName: "play.circle.fill")
                .font(.system(size: 44))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white)
                .shadow(radius: 4)
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fill)
        .frame(maxWidth: .infinity)
        .clipped()
    }
}
