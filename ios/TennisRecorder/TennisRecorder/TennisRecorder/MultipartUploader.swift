import Foundation

/// Uploads a recorded file to the backend using the multipart flow:
/// initiate → PUT each part directly to storage → complete.
///
/// Parts are read as byte ranges from the file on disk, so memory use stays flat
/// regardless of a 2-hour recording's size. Returns the remote video id so the
/// caller can build a shareable watch link.
struct MultipartUploader {
    var api = UploadAPI()

    func upload(
        fileURL: URL,
        title: String,
        durationS: Double,
        onProgress: @Sendable @escaping (Double) -> Void
    ) async throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? Int) ?? 0

        let start = try await api.initiate(title: title, contentType: "video/quicktime", sizeBytes: size)
        let partSize = start.partSizeBytes
        let partCount = max(1, Int(ceil(Double(size) / Double(partSize))))

        var uploaded: [UploadedPart] = []
        var uploadedBytes = 0

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        for partNumber in 1...partCount {
            let offset = (partNumber - 1) * partSize
            try handle.seek(toOffset: UInt64(offset))
            let chunk = try handle.read(upToCount: partSize) ?? Data()

            let part = try await api.partURL(videoId: start.videoId, partNumber: partNumber)
            var put = URLRequest(url: api.absolutePartURL(part.url))
            put.httpMethod = part.method // "PUT"

            // TODO(background): for production, write `chunk` to a temp file and use a
            // `URLSession(configuration: .background(...))` uploadTask(fromFile:) so the
            // transfer survives app suspension. Sequential in-process upload keeps this simple.
            let (_, response) = try await URLSession.shared.upload(for: put, from: chunk)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                throw UploadError.server(status: status, message: "part \(partNumber) upload failed")
            }
            let etag = (http.value(forHTTPHeaderField: "ETag") ?? "")
                .replacingOccurrences(of: "\"", with: "")

            uploaded.append(UploadedPart(partNumber: partNumber, etag: etag, size: chunk.count))
            uploadedBytes += chunk.count
            onProgress(Double(uploadedBytes) / Double(max(size, 1)))
        }

        try await api.complete(videoId: start.videoId, parts: uploaded, durationS: durationS)
        return start.videoId
    }
}
