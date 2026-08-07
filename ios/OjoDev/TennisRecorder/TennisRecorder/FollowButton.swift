import SwiftUI

/// Optimistic follow / unfollow button. Mirrors the web `FollowButton`.
struct FollowButton: View {
    let userId: String
    @State private var following: Bool

    private let api = UploadAPI()

    init(userId: String, initiallyFollowing: Bool) {
        self.userId = userId
        _following = State(initialValue: initiallyFollowing)
    }

    var body: some View {
        Button { toggle() } label: {
            Text(following ? "Following" : "Follow")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(following ? Theme.muted : Theme.text)
                .padding(.horizontal, 18).padding(.vertical, 8)
                .background(
                    Capsule().fill(following ? Color.clear : Theme.accent)
                )
                .overlay(
                    Capsule().stroke(following ? Theme.border : Color.clear, lineWidth: 1.5)
                )
        }
        .buttonStyle(.plain)
    }

    private func toggle() {
        let n = !following
        following = n
        Task {
            if let f = try? await api.setFollow(userId: userId, following: n) { following = f }
        }
    }
}
