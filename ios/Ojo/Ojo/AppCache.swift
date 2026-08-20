import Combine
import Foundation

/// Shared, short-lived cache for the things every tab re-fetches.
///
/// Each screen kept its results in `@State`, so SwiftUI threw them away when you
/// switched tabs and the next visit started from an empty view and a spinner —
/// even if you'd been there two seconds earlier. Holding them here means a tab
/// switch paints immediately from what we already have, and only goes to the
/// network when the data is actually stale.
@MainActor
final class AppCache: ObservableObject {
    static let shared = AppCache()

    @Published private(set) var feed: [FeedItem] = []
    @Published private(set) var profile: ProfileSummary?
    @Published private(set) var feedError: String?

    /// How long a result is considered good enough to show without a refetch.
    /// Pull-to-refresh always bypasses this.
    private static let ttl: TimeInterval = 60

    private var feedFetchedAt: Date?
    private var profileFetchedAt: Date?
    private let api = UploadAPI()

    private init() {}

    private static func isStale(_ at: Date?) -> Bool {
        guard let at else { return true }
        return Date().timeIntervalSince(at) > ttl
    }

    /// True when there's nothing to show yet — the only time a spinner is right.
    var feedIsEmpty: Bool { feed.isEmpty }

    func refreshFeed(force: Bool = false) async {
        guard force || Self.isStale(feedFetchedAt) else { return }
        do {
            feed = try await api.getFeed()
            feedFetchedAt = Date()
            feedError = nil
        } catch {
            feedError = "Couldn't load your feed. Pull to refresh."
        }
    }

    func refreshProfile(force: Bool = false) async {
        guard force || Self.isStale(profileFetchedAt) else { return }
        if let resp = try? await api.getMyProfile() {
            profile = resp.profile
            profileFetchedAt = Date()
        }
    }

    /// Called after editing your profile, so the next read doesn't serve the old name.
    func invalidateProfile() { profileFetchedAt = nil }

    /// Drop everything on sign-out — the next account must not see this one's data.
    func clear() {
        feed = []
        profile = nil
        feedError = nil
        feedFetchedAt = nil
        profileFetchedAt = nil
    }
}
