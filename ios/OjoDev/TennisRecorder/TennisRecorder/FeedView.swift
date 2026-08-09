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
        .refreshable { await reload(force: true) }
        .task { await reload() }
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
    }
}
