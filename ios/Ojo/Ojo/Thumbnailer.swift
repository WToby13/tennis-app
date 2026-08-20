import AVFoundation
import UIKit

/// Generates and caches poster-frame thumbnails for locally recorded matches.
///
/// A frame is grabbed with `AVAssetImageGenerator` from the recording's `.mov`,
/// then cached both in memory (`NSCache`) and on disk
/// (`Documents/thumbnails/<id>.jpg`) so it survives relaunches and only costs one
/// decode per recording. All of this works offline, before a clip is uploaded.
enum Thumbnailer {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 200
        return cache
    }()

    private static var directory: URL {
        let dir = RecordingStore.documentsURL.appendingPathComponent("thumbnails", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func diskURL(for id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString).jpg")
    }

    /// A thumbnail if one is already cached (memory or disk). Cheap — never generates.
    static func cached(for id: UUID) -> UIImage? {
        let key = id.uuidString as NSString
        if let image = cache.object(forKey: key) { return image }
        if let data = try? Data(contentsOf: diskURL(for: id)), let image = UIImage(data: data) {
            cache.setObject(image, forKey: key)
            return image
        }
        return nil
    }

    /// A thumbnail for the recording, generating (and caching) it from the video if
    /// needed. Returns nil if the file is missing or no frame could be read.
    static func thumbnail(for id: UUID, videoURL: URL) async -> UIImage? {
        if let image = cached(for: id) { return image }
        guard FileManager.default.fileExists(atPath: videoURL.path) else { return nil }

        let asset = AVURLAsset(url: videoURL)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true // respect the recording's orientation
        generator.maximumSize = CGSize(width: 640, height: 640)

        // Grab the frame 60s in (a point where play is likely under way), or the
        // last frame for clips shorter than a minute. Tolerating earlier — but not
        // later — snaps cleanly to the final frame of a short clip.
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        let target = duration.isFinite && duration > 0 ? min(60, duration) : 60
        generator.requestedTimeToleranceBefore = CMTime(seconds: 2, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = .zero

        let time = CMTime(seconds: target, preferredTimescale: 600)
        do {
            let cgImage = try await generator.image(at: time).image
            let image = UIImage(cgImage: cgImage)
            cache.setObject(image, forKey: id.uuidString as NSString)
            if let data = image.jpegData(compressionQuality: 0.8) {
                try? data.write(to: diskURL(for: id), options: .atomic)
            }
            return image
        } catch {
            return nil
        }
    }

    /// Fetch a cloud-only recording's thumbnail from the web, caching it to memory
    /// and disk so it renders instantly next time. Returns nil if unavailable.
    static func fetchRemote(for id: UUID, url: URL) async -> UIImage? {
        if let image = cached(for: id) { return image }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: id.uuidString as NSString)
        try? data.write(to: diskURL(for: id), options: .atomic)
        return image
    }

    /// Drop a recording's thumbnail from memory and disk (call when it's deleted).
    static func delete(id: UUID) {
        cache.removeObject(forKey: id.uuidString as NSString)
        try? FileManager.default.removeItem(at: diskURL(for: id))
    }
}
