import Combine
import Foundation

/// Links from the website into the app: "Open" on the site's banner for iPhone
/// browsers (`ojo://watch/<id>?s=<share token>`, web/app/AppBanner.tsx), and
/// Safari's Smart App Banner, which hands over the page's own address
/// (`https://ojotennis.com/watch/<id>?s=…`). Either opens the same match.
///
/// The link is held until there's somewhere to show it: someone signed out
/// signs in first, then lands on the match (MainTabView consumes it).
@MainActor
final class DeepLinks: ObservableObject {
    static let shared = DeepLinks()

    struct Match: Equatable {
        let id: String
        /// From a shared link: lets someone the match isn't theirs open it.
        let shareToken: String?
    }

    /// A match waiting to be opened.
    @Published var pending: Match?

    /// Takes a URL the app was opened with. Anything that isn't a match (the
    /// app's home, `ojo://open`, or the sign-in callback) is left alone.
    func handle(_ url: URL) {
        if let match = Self.match(in: url) { pending = match }
    }

    static func match(in url: URL) -> Match? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let segments: [String]
        switch parts.scheme?.lowercased() {
        case "ojo":
            // ojo://watch/<id>: the host is the first segment.
            segments = [parts.host ?? ""] + parts.path.split(separator: "/").map(String.init)
        case "https", "http":
            segments = parts.path.split(separator: "/").map(String.init)
        default:
            return nil
        }
        guard segments.count >= 2, segments[0] == "watch", UUID(uuidString: segments[1]) != nil else { return nil }
        let token = parts.queryItems?.first(where: { $0.name == "s" })?.value
        return Match(id: segments[1].lowercased(), shareToken: token?.isEmpty == false ? token : nil)
    }

    /// A shared match isn't readable in the app until it's yours: add it to the
    /// signed-in person's matches first, as "Add to my account" does on the web.
    /// A link that no longer works just opens the match as it stands.
    func claim(_ match: Match) async {
        guard let token = match.shareToken,
              let bearer = await Supa.accessToken(),
              let body = try? JSONEncoder().encode(["token": token]) else { return }
        let api = UploadAPI()
        var req = URLRequest(url: api.endpoint("/api/videos/\(match.id)/add"))
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
    }
}
