import SwiftUI

/// The Home tab — the social feed: matches from players you follow, plus your
/// own, newest first. Tap a card to open the match; like / comment / share /
/// save inline.
struct FeedView: View {
    @State private var items: [FeedItem] = []
    @State private var loading = true
    @State private var loadError: String?

    private let api = UploadAPI()

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
        .refreshable { await reload() }
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
        .refreshable { await reload() }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            items = try await api.getFeed()
            loadError = nil
        } catch {
            loadError = "Couldn't load your feed. Pull to refresh."
        }
    }
}
