import Foundation

/// Uploads a recorded file to the backend using the multipart flow:
/// initiate → (resume via list-parts) → PUT each part → complete.
///
/// The parts are read as byte ranges from the recorded file on disk, so memory
/// use stays flat regardless of a 2-hour recording's size.
@MainActor
final class MultipartUploader: ObservableObject {
    @Published var progress: Double = 0
    @Published var state: String = "idle"

    private let api: UploadAPI

    init(api: UploadAPI = UploadAPI()) {
        self.api = api
    }

    func upload(fileURL: URL, title: String, durationS: Double) async {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let size = (attrs[.size] as? Int) ?? 0
            state = "initiating"

            let init0 = try await api.initiate(title: title, contentType: "video/quicktime", sizeBytes: size)
            let partSize = init0.partSizeBytes
            let partCount = max(1, Int(ceil(Double(size) / Double(partSize))))

            // TODO(resume): call api.listParts(videoId:) and skip parts already present.
            var uploaded: [UploadedPart] = []
            var uploadedBytes = 0

            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }

            state = "uploading"
            for partNumber in 1...partCount {
                let offset = (partNumber - 1) * partSize
                try handle.seek(toOffset: UInt64(offset))
                let chunk = try handle.read(upToCount: partSize) ?? Data()

                let part = try await api.partURL(videoId: init0.videoId, partNumber: partNumber)
                var put = URLRequest(url: api.absolutePartURL(part.url))
                put.httpMethod = part.method // "PUT"

                // TODO(background): for production, write `chunk` to a temp file and use a
                // `URLSession(configuration: .background(...))` uploadTask(fromFile:) so the
                // transfer continues if the app is suspended. Sequential in-process upload here
                // keeps the reference simple.
                let (_, response) = try await URLSession.shared.upload(for: put, from: chunk)
                let etag = ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag") ?? "")
                    .replacingOccurrences(of: "\"", with: "")

                uploaded.append(UploadedPart(partNumber: partNumber, etag: etag, size: chunk.count))
                uploadedBytes += chunk.count
                progress = Double(uploadedBytes) / Double(size)
            }

            state = "completing"
            try await api.complete(videoId: init0.videoId, parts: uploaded, durationS: durationS)
            state = "done"
        } catch {
            state = "failed: \(error.localizedDescription)"
        }
    }
}
