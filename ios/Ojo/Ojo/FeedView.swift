import SwiftUI

/// The Home tab — the social feed: matches from players you follow, plus your
/// own, newest first. Tap a card to open the match; like / comment / share /
/// save inline.
struct FeedView: View {
    /// Shared so switching tabs doesn't throw the feed away and re-fetch it.
    @ObservedObject private var cache = AppCache.shared
    @State private var loading = false

    private var items: [FeedItem] { cache.feed }
    private var loadError: String? { cache.feedError }

    var body: some View {
        Group {
            if loading && items.isEmpty {
                ProgressView().tint(Theme.accent)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if items.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 18) {
                        ForEach(items) { item in
                            FeedCardView(item: item)
                        }
                    }
                    .padding(.vertical, 12)
                }
            }
        }
        .background(Theme.bg)
        .navigationTitle("Home")
        // Centred, on the same row as the search glass — the large title stacked a
        // second "Home" under it, and every other screen in the app is inline.
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: SearchTarget.players) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                }
                .accessibilityLabel("Search players")
            }
            ToolbarItem(placement: .topBarLeading) {
                NotificationBell()
            }
        }
        .refreshable { await reload(force: true) }
        // One task, not two. Stacking `.task` modifiers is legal but leaves the
        // badge depending on a detail I would rather not rely on; sequencing them
        // here is unambiguous.
        .task {
            await reload()
            // Home is where the badge lives, so it is where it gets refreshed —
            // every visit, and always from the network. A badge exists to be
            // current, and one small query is a fair price for that; the 60s
            // cache is right for the feed, not for this.
            await cache.refreshNotifications(force: true)
        }
    }

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "house.fill").font(.system(size: 40)).foregroundStyle(Theme.muted)
                Text("Your feed is quiet").font(.headline).foregroundStyle(Theme.text)
                Text(loadError ?? "Follow players and their shared matches will show up here.")
                    .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                PeopleSearch().padding(.top, 8)
            }
            .padding(24)
        }
        .refreshable { await reload(force: true) }
    }

    /// The cache decides whether this actually hits the network; the spinner only
    /// shows when there's nothing cached to display.
    private func reload(force: Bool = false) async {
        loading = true
        defer { loading = false }
        await cache.refreshFeed(force: force)
        // Pulling down on Home is the obvious way to ask "anything new?", and
        // the bell is right there — so it answers for the inbox too.
        if force { await cache.refreshNotifications(force: true) }
    }
}
