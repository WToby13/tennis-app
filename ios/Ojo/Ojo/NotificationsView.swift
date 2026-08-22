import SwiftUI

/// Where the inbox lives — pushed from the bell beside the Home title.
enum InboxTarget: Hashable {
    case inbox
}

/// A match opened from a notification: the same Watch screen, landing on the
/// conversation rather than the top of the page. Its own push target so
/// `WatchTarget` keeps meaning "a match", and every other way in still opens
/// where it always did.
struct CommentTarget: Hashable {
    let videoId: String
}

/// The notification inbox: who said what, on which match, and a way straight to
/// it.
///
/// There are exactly two reasons to be here — someone tagged you, or someone
/// added to a conversation you are already in — and the row says which, because
/// they are worth different amounts of attention.
struct NotificationsView: View {
    @ObservedObject private var cache = AppCache.shared
    @State private var loading = false

    private var items: [AppNotification] { cache.notifications }

    var body: some View {
        Group {
            if loading && items.isEmpty {
                ProgressView().tint(Theme.accent)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if items.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            NotificationRow(item: item)
                            Rectangle().fill(Theme.border).frame(height: 0.5)
                        }
                    }
                }
            }
        }
        .background(Theme.bg)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload(force: true) }
        .task {
            await reload()
            await cache.markNotificationsRead()
        }
    }

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 14) {
                Image(systemName: "bell").font(.system(size: 40)).foregroundStyle(Theme.muted)
                Text("Nothing yet").font(.headline).foregroundStyle(Theme.text)
                Text("Tag someone with @ in a comment and they'll hear about it here.")
                    .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await reload(force: true) }
    }

    private func reload(force: Bool = false) async {
        loading = true
        defer { loading = false }
        await cache.refreshNotifications(force: force)
    }
}

private struct NotificationRow: View {
    let item: AppNotification

    var body: some View {
        NavigationLink(value: CommentTarget(videoId: item.videoId)) {
            HStack(alignment: .top, spacing: 12) {
                Avatar(name: item.actorName, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    headline
                    if let body = item.body, !body.isEmpty {
                        // A preview, not the live comment: there's nothing to
                        // seek from here, and a tappable timestamp inside a row
                        // that is itself a link would fight for the same tap.
                        Text(CommentMarkup.plainText(body))
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                if item.isUnread {
                    Circle().fill(Theme.accent).frame(width: 8, height: 8).padding(.top, 6)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var headline: some View {
        let actor = item.actorName ?? "Someone"
        let verb = item.kind == "mention" ? "tagged you in" : "commented on"
        let match = item.videoTitle ?? "a match"
        return (
            Text(actor).font(.subheadline.weight(.semibold))
                + Text(" \(verb) ").font(.subheadline)
                + Text(match).font(.subheadline.weight(.semibold))
                + Text(" · \(relativeDate(item.createdAt))").font(.caption)
        )
        .foregroundStyle(Theme.text)
        .multilineTextAlignment(.leading)
    }

    private func relativeDate(_ iso: String) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: parseISODate(iso), relativeTo: Date())
    }
}

/// The bell beside the Home title, badged with what's waiting.
struct NotificationBell: View {
    @ObservedObject private var cache = AppCache.shared

    var body: some View {
        NavigationLink(value: InboxTarget.inbox) {
            Image(systemName: "bell")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.text)
                .overlay(alignment: .topTrailing) {
                    if cache.unreadNotifications > 0 {
                        Text(cache.unreadNotifications > 9 ? "9+" : "\(cache.unreadNotifications)")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Theme.accent, in: Capsule())
                            .offset(x: 10, y: -8)
                            .fixedSize()
                    }
                }
        }
        .accessibilityLabel(cache.unreadNotifications > 0
                            ? "Notifications, \(cache.unreadNotifications) unread"
                            : "Notifications")
    }
}
