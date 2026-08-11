import Foundation

/// Config — point this at your web app (Vercel URL, or your Mac's LAN IP for local dev).
enum Config {
    static let apiBaseURL = URL(string: "https://ojotennis.com")!
    /// Match the server default (PART_SIZE_BYTES). S3 minimum is 5 MB.
    static let partSizeBytes = 8 * 1024 * 1024

    /// Public URL where a finished match can be watched/shared.
    static func watchURL(videoId: String) -> URL {
        apiBaseURL.appendingPathComponent("watch").appendingPathComponent(videoId)
    }
}

// MARK: - Wire types (mirror the Next.js API responses)

struct InitiateResponse: Decodable {
    let videoId: String
    let key: String
    let uploadId: String
    let partSizeBytes: Int
}

struct PartURLResponse: Decodable {
    let url: String
    let method: String
    let partNumber: Int
}

struct UploadedPart: Codable {
    let partNumber: Int
    let etag: String
    let size: Int
}

struct ListPartsResponse: Decodable {
    let parts: [UploadedPart]
    let partSizeBytes: Int
}

struct ThumbnailURLResponse: Decodable {
    let url: String
    let method: String
}

/// A video as returned by the web API (mirrors the `Video` type there, plus a
/// signed `thumbnailUrl`). Extra fields in the JSON are ignored.
struct RemoteVideo: Decodable {
    let id: String
    let ownerId: String?
    let title: String
    let status: String
    let durationS: Double?
    let sizeBytes: Int?
    let createdAt: String?
    let thumbnailUrl: String?
    let visibility: String?
    /// Derived upload/analysis/share state. Optional so the app keeps working
    /// against a server deployed before this field existed.
    let matchStatus: MatchStatus?
}

struct VideosResponse: Decodable {
    let videos: [RemoteVideo]
}

/// A participant as returned by the video-detail endpoint (has a row `id`).
struct RemoteParticipant: Decodable {
    let id: String?
    let userId: String?
    let displayName: String
    let email: String?
}

struct VideoAuthor: Decodable {
    let id: String
    let displayName: String
}

struct VideoDetailResponse: Decodable {
    let video: RemoteVideo
    let playbackUrl: String?
    let thumbnailUrl: String?
    // Social + permission fields (present in auth mode; optional so playback-only
    // callers and local no-auth mode still decode).
    let isOwner: Bool?
    let canEdit: Bool?
    let inLibrary: Bool?
    let canAdd: Bool?
    let participants: [RemoteParticipant]?
    let likeCount: Int?
    let likedByMe: Bool?
    let sharedToFollowers: Bool?
    let author: VideoAuthor?
    let isFollowingOwner: Bool?
    // AI rally breakdown — the detail route returns the full analysis state, so one
    // fetch seeds the breakdown UI and only re-runs/polls need the analyze route.
    let analysisStatus: String?
    let analysisError: String?
    let analysisPlayers: AnalysisPlayers?
    let segments: [AnalysisSegment]?
    let canAnalyze: Bool?
}

// MARK: - Social wire types (mirror web lib/social/types.ts)

/// One item in the home feed (`GET /api/feed`).
struct FeedItem: Decodable, Identifiable, Hashable {
    let id: String
    let ownerId: String?
    let title: String
    let status: String
    let durationS: Double?
    let sizeBytes: Int?
    let createdAt: String?
    let visibility: String?
    let authorName: String?
    let sharedBy: String?
    let sharedByName: String?
    let participantNames: String?   // a single joined string, not an array
    let likeCount: Int
    let commentCount: Int
    let likedByMe: Bool
    let inLibrary: Bool
    let thumbnailUrl: String?
}

struct FeedResponse: Decodable { let feed: [FeedItem] }

struct LikeState: Decodable { let count: Int; let likedByMe: Bool }

struct Comment: Decodable, Identifiable, Hashable {
    let id: String
    let videoId: String?
    let authorId: String?
    let authorName: String?
    let body: String
    let createdAt: String?
    let canDelete: Bool
}

struct CommentsResponse: Decodable { let comments: [Comment] }

struct ProfileSummary: Decodable {
    let id: String
    let displayName: String
    let followers: Int
    let following: Int
    let isFollowing: Bool
}

/// A video in a user's public profile (a picked subset, not the full video).
struct ProfileVideo: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let durationS: Double?
    let sizeBytes: Int?
    let createdAt: String?
    let thumbnailUrl: String?
}

struct UserProfileResponse: Decodable {
    let profile: ProfileSummary
    let videos: [ProfileVideo]
    let isSelf: Bool
}

struct FollowResponse: Decodable { let following: Bool }
struct SharedResponse: Decodable { let shared: Bool }
struct SavedResponse: Decodable { let saved: Bool }
struct ShareLinkResponse: Decodable { let token: String; let path: String }

/// An Ojo user returned by the search endpoint, for tagging as a participant.
struct UserResult: Decodable, Identifiable {
    let id: String
    let displayName: String
}

struct UsersResponse: Decodable {
    let users: [UserResult]
}

// MARK: - AI rally breakdown wire types (mirror web lib/metadata/types.ts)

/// Display names for the two analysis players. `player_1` is whoever starts near
/// the camera, `player_2` far — a relabel of the model's own ids, not a re-run.
struct AnalysisPlayers: Codable, Equatable {
    var player1: String?
    var player2: String?

    enum CodingKeys: String, CodingKey {
        case player1 = "player_1"
        case player2 = "player_2"
    }
}

/// The fields the structural smoother stamps onto every rally (web
/// lib/twelvelabs/smooth.ts). Counts decode as `Double` so an int or float both
/// work; unknown keys from the raw model output are ignored.
struct RallyMetadata: Decodable {
    let game: Double?
    let server: String?
    let receiver: String?
    let nearPlayer: String?
    let nearRole: String?
    let servingSide: String?
    let shots: Double?
    let whatYouSee: String?

    enum CodingKeys: String, CodingKey {
        case game, server, receiver, shots
        case nearPlayer = "near_player"
        case nearRole = "near_role"
        case servingSide = "serving_side"
        case whatYouSee = "what_you_see"
    }
}

/// One AI-produced rally within a match.
struct AnalysisSegment: Decodable, Identifiable {
    let id: String
    let idx: Int?
    let startS: Double?
    let endS: Double?
    let metadata: RallyMetadata?
}

/// Response shape of both `POST` (start) and `GET` (poll) on the analyze route.
/// A start returns only the status; a poll carries the segments once ready.
struct AnalysisResponse: Decodable {
    let analysisStatus: String?
    let analysisError: String?
    let segments: [AnalysisSegment]?
}

/// Readable upload failures, so the UI can show something better than a raw
/// JSON-decoding error.
enum UploadError: LocalizedError {
    case notSignedIn
    case server(status: Int, message: String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return "You're signed out. Sign in and try again."
        case let .server(status, message):
            return "Server error (\(status)): \(message)"
        case .badResponse:
            return "Unexpected response from the server."
        }
    }
}

/// Thin client over the multipart API. All calls go to the same endpoints the
/// web `uploadClient.ts` uses, so iOS and web share one backend contract.
struct UploadAPI {
    var baseURL = Config.apiBaseURL

    /// Builds a request and attaches the current Supabase JWT as a Bearer token.
    /// Throws `.notSignedIn` up front if there's no session, rather than firing an
    /// unauthenticated request that the server would reject.
    private func makeRequest(_ path: String, method: String, body: Data?) async throws -> URLRequest {
        guard let token = await Supa.accessToken() else { throw UploadError.notSignedIn }
        var req = URLRequest(url: endpoint(path))
        req.httpMethod = method
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    /// Perform a request and validate the HTTP status, surfacing the server's
    /// error message on failure. Returns the raw response body.
    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw UploadError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let serverMessage = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            let raw = String(data: data, encoding: .utf8)?.prefix(200).trimmingCharacters(in: .whitespacesAndNewlines)
            throw UploadError.server(status: http.statusCode, message: serverMessage ?? raw ?? "request failed")
        }
        return data
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data? = nil) async throws -> T {
        let data = try await perform(try await makeRequest(path, method: method, body: body))
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw UploadError.badResponse
        }
    }

    /// Encode participants for a JSON body (drops empty names, omits nil fields).
    private static func participantsJSON(_ participants: [Participant]) -> [[String: Any]] {
        participants.compactMap { p in
            let name = p.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return nil }
            var d: [String: Any] = ["displayName": name]
            if let u = p.userId, !u.isEmpty { d["userId"] = u }
            if let e = p.email, !e.isEmpty { d["email"] = e }
            return d
        }
    }

    func initiate(title: String, contentType: String, sizeBytes: Int,
                  participants: [Participant] = []) async throws -> InitiateResponse {
        var obj: [String: Any] = ["title": title, "contentType": contentType, "sizeBytes": sizeBytes]
        let ps = Self.participantsJSON(participants)
        if !ps.isEmpty { obj["participants"] = ps }
        let body = try JSONSerialization.data(withJSONObject: obj)
        return try await send("/api/uploads/initiate", method: "POST", body: body)
    }

    /// Search Ojo users by name, for tagging as participants.
    func searchUsers(_ query: String) async throws -> [UserResult] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return [] }
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        let resp: UsersResponse = try await send("/api/users?q=\(enc)", method: "GET")
        return resp.users
    }

    /// Replace a match's participant list (owner-only, enforced server-side).
    func setParticipants(videoId: String, participants: [Participant]) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "participants": Self.participantsJSON(participants),
        ])
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)/participants", method: "PUT", body: body))
    }

    func partURL(videoId: String, partNumber: Int) async throws -> PartURLResponse {
        let body = try JSONSerialization.data(withJSONObject: ["partNumber": partNumber])
        return try await send("/api/uploads/\(videoId)/part-url", method: "POST", body: body)
    }

    func listParts(videoId: String) async throws -> ListPartsResponse {
        return try await send("/api/uploads/\(videoId)/list-parts", method: "GET")
    }

    func complete(videoId: String, parts: [UploadedPart], durationS: Double) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "parts": parts.map { ["partNumber": $0.partNumber, "etag": $0.etag, "size": $0.size] },
            "durationS": durationS,
        ])
        _ = try await perform(try await makeRequest("/api/uploads/\(videoId)/complete", method: "POST", body: body))
    }

    /// Upload a video's poster thumbnail (a small JPEG). Presigns a direct PUT and
    /// sends the bytes straight to storage — same pattern as video parts. The
    /// presigned URL is self-authorizing, so no Bearer token is attached to the PUT.
    func uploadThumbnail(videoId: String, jpeg: Data) async throws {
        let presign: ThumbnailURLResponse = try await send("/api/uploads/\(videoId)/thumbnail-url", method: "POST")
        var req = URLRequest(url: absolutePartURL(presign.url))
        req.httpMethod = "PUT"
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.upload(for: req, from: jpeg)
        guard let http = response as? HTTPURLResponse else { throw UploadError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let raw = String(data: data, encoding: .utf8)?.prefix(200).trimmingCharacters(in: .whitespacesAndNewlines)
            throw UploadError.server(status: http.statusCode, message: raw ?? "thumbnail upload failed")
        }
    }

    /// List the signed-in user's videos (the server returns all readable videos;
    /// the caller filters to its own).
    func listVideos() async throws -> [RemoteVideo] {
        let resp: VideosResponse = try await send("/api/videos", method: "GET")
        return resp.videos
    }

    /// Fetch one video's detail, including a signed playback URL when it's ready.
    func getVideo(videoId: String) async throws -> VideoDetailResponse {
        try await send("/api/videos/\(videoId)", method: "GET")
    }

    /// Delete a video (and its assets) from the cloud. Owner-only, enforced server-side.
    func deleteVideo(videoId: String) async throws {
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)", method: "DELETE", body: nil))
    }

    /// Resolve an API path against the base URL.
    ///
    /// NOT `appendingPathComponent`: that treats the whole string as one path
    /// segment and percent-encodes the `?`, so `/api/users?q=ada` went out as
    /// `/api/users%3Fq=ada` and every player search came back empty. Resolving it
    /// as a relative URL keeps the query a query.
    func endpoint(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL.appendingPathComponent(path)
    }

    /// Resolve a relative part URL (local backend) against the API base; S3 returns absolute URLs.
    func absolutePartURL(_ url: String) -> URL {
        if url.hasPrefix("http") { return URL(string: url)! }
        return baseURL.appendingPathComponent(url)
    }
}

// MARK: - Social API

/// The consumption/social half of the backend contract — the same routes the web
/// app calls, so iOS reaches full feature parity. (Same file as `UploadAPI` so
/// these can use its private request helpers.)
extension UploadAPI {
    /// The home feed: matches from players you follow, plus your own.
    func getFeed() async throws -> [FeedItem] {
        let resp: FeedResponse = try await send("/api/feed", method: "GET")
        return resp.feed
    }

    /// Like (POST) or unlike (DELETE) a match; returns the new like state.
    func setLike(videoId: String, liked: Bool) async throws -> LikeState {
        try await send("/api/videos/\(videoId)/like", method: liked ? "POST" : "DELETE")
    }

    /// All comments on a match (newest handling is server-side).
    func listComments(videoId: String) async throws -> [Comment] {
        let resp: CommentsResponse = try await send("/api/videos/\(videoId)/comments", method: "GET")
        return resp.comments
    }

    /// Post a comment; returns the refreshed full list.
    func addComment(videoId: String, body text: String) async throws -> [Comment] {
        let body = try JSONSerialization.data(withJSONObject: ["body": text])
        let resp: CommentsResponse = try await send("/api/videos/\(videoId)/comments", method: "POST", body: body)
        return resp.comments
    }

    func deleteComment(videoId: String, commentId: String) async throws {
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)/comments/\(commentId)", method: "DELETE", body: nil))
    }

    /// Follow (POST) or unfollow (DELETE) a user; returns the new following state.
    func setFollow(userId: String, following: Bool) async throws -> Bool {
        let resp: FollowResponse = try await send("/api/users/\(userId)/follow", method: following ? "POST" : "DELETE")
        return resp.following
    }

    /// A user's public profile: summary, follow state, and their matches.
    func getUserProfile(userId: String) async throws -> UserProfileResponse {
        try await send("/api/users/\(userId)", method: "GET")
    }

    /// The signed-in user's own profile, without needing their id first — the
    /// route resolves `me` server-side from the request's session.
    func getMyProfile() async throws -> UserProfileResponse {
        try await send("/api/users/me", method: "GET")
    }

    /// Add a match to your profile/library ("save"). No un-save from here (matches web).
    @discardableResult
    func saveToLibrary(videoId: String) async throws -> Bool {
        let resp: SavedResponse = try await send("/api/videos/\(videoId)/save", method: "POST")
        return resp.saved
    }

    /// Post (POST) / unpost (DELETE) a match to your followers' feeds.
    func setSharedToFollowers(videoId: String, shared: Bool) async throws -> Bool {
        let resp: SharedResponse = try await send("/api/videos/\(videoId)/share-to-followers", method: shared ? "POST" : "DELETE")
        return resp.shared
    }

    /// Mint (or reuse) a revocable share link; returns the token + watch path.
    func createShareLink(videoId: String) async throws -> ShareLinkResponse {
        try await send("/api/videos/\(videoId)/share", method: "POST")
    }

    /// Update a match's title (owner or participant).
    func setTitle(videoId: String, title: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["title": title])
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)", method: "PATCH", body: body))
    }

    /// Rename the two analysis players without re-running the breakdown — the
    /// labels are stored on the video, not baked into the segments.
    func setAnalysisPlayers(videoId: String, players: AnalysisPlayers) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "players": [
                "player_1": players.player1 ?? "",
                "player_2": players.player2 ?? "",
            ],
        ])
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)", method: "PATCH", body: body))
    }

    /// Update a match's visibility (owner only). Accepts "private" | "public".
    func setVisibility(videoId: String, visibility: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["visibility": visibility])
        _ = try await perform(try await makeRequest("/api/videos/\(videoId)", method: "PATCH", body: body))
    }
}

// MARK: - AI rally breakdown

extension UploadAPI {
    /// Start (or re-run) the AI rally breakdown. Owner-only, enforced server-side.
    /// `startTimeSec` trims warm-up hitting so the model starts at the first real
    /// game; `players` are display names stored alongside the result.
    @discardableResult
    func startAnalysis(videoId: String,
                       startTimeSec: Double? = nil,
                       players: AnalysisPlayers? = nil) async throws -> AnalysisResponse {
        var obj: [String: Any] = [:]
        if let startTimeSec, startTimeSec > 0 { obj["startTimeSec"] = startTimeSec }
        if let players {
            obj["players"] = [
                "player_1": players.player1 ?? "",
                "player_2": players.player2 ?? "",
            ]
        }
        let body = try JSONSerialization.data(withJSONObject: obj)
        return try await send("/api/videos/\(videoId)/analyze", method: "POST", body: body)
    }

    /// Poll the breakdown. A scheduled server-side sweep advances runs on its own
    /// now, but the owner's poll advances them too — and it's what makes a finished
    /// run appear while you're looking at it — so keep calling while "processing".
    func getAnalysis(videoId: String) async throws -> AnalysisResponse {
        try await send("/api/videos/\(videoId)/analyze", method: "GET")
    }
}
