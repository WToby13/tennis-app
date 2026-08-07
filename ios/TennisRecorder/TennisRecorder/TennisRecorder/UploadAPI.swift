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
}

struct VideosResponse: Decodable {
    let videos: [RemoteVideo]
}

struct VideoDetailResponse: Decodable {
    let video: RemoteVideo
    let playbackUrl: String?
    let thumbnailUrl: String?
}

/// An Ojo user returned by the search endpoint, for tagging as a participant.
struct UserResult: Decodable, Identifiable {
    let id: String
    let displayName: String
}

struct UsersResponse: Decodable {
    let users: [UserResult]
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
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
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

    /// Resolve a relative part URL (local backend) against the API base; S3 returns absolute URLs.
    func absolutePartURL(_ url: String) -> URL {
        if url.hasPrefix("http") { return URL(string: url)! }
        return baseURL.appendingPathComponent(url)
    }
}
