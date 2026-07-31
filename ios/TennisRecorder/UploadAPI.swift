import Foundation

/// Config — point this at your web app (Vercel URL, or your Mac's LAN IP for local dev).
enum Config {
    static let apiBaseURL = URL(string: "http://192.168.1.100:3000")!
    /// Match the server default (PART_SIZE_BYTES). S3 minimum is 5 MB.
    static let partSizeBytes = 8 * 1024 * 1024
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

/// Thin client over the multipart API. All calls go to the same endpoints the
/// web `uploadClient.ts` uses, so iOS and web share one backend contract.
struct UploadAPI {
    var baseURL = Config.apiBaseURL

    /// Builds a request and attaches the current Supabase JWT as a Bearer token,
    /// so the API authenticates the caller and RLS scopes the data to them.
    private func request(_ path: String, method: String, body: Data? = nil) async -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token = await Supa.accessToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    func initiate(title: String, contentType: String, sizeBytes: Int) async throws -> InitiateResponse {
        let body = try JSONSerialization.data(withJSONObject: [
            "title": title, "contentType": contentType, "sizeBytes": sizeBytes,
        ])
        let (data, _) = try await URLSession.shared.data(for: await request("/api/uploads/initiate", method: "POST", body: body))
        return try JSONDecoder().decode(InitiateResponse.self, from: data)
    }

    func partURL(videoId: String, partNumber: Int) async throws -> PartURLResponse {
        let body = try JSONSerialization.data(withJSONObject: ["partNumber": partNumber])
        let (data, _) = try await URLSession.shared.data(for: await request("/api/uploads/\(videoId)/part-url", method: "POST", body: body))
        return try JSONDecoder().decode(PartURLResponse.self, from: data)
    }

    func listParts(videoId: String) async throws -> ListPartsResponse {
        let (data, _) = try await URLSession.shared.data(for: await request("/api/uploads/\(videoId)/list-parts", method: "GET"))
        return try JSONDecoder().decode(ListPartsResponse.self, from: data)
    }

    func complete(videoId: String, parts: [UploadedPart], durationS: Double) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "parts": parts.map { ["partNumber": $0.partNumber, "etag": $0.etag, "size": $0.size] },
            "durationS": durationS,
        ])
        _ = try await URLSession.shared.data(for: await request("/api/uploads/\(videoId)/complete", method: "POST", body: body))
    }

    /// Resolve a relative part URL (local backend) against the API base; S3 returns absolute URLs.
    func absolutePartURL(_ url: String) -> URL {
        if url.hasPrefix("http") { return URL(string: url)! }
        return baseURL.appendingPathComponent(url)
    }
}
