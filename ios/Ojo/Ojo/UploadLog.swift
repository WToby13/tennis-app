import Foundation
import OSLog

/// The upload's flight recorder.
///
/// Long uploads fail in the field, hours from a debugger, and the only thing the
/// app used to keep was a one-line message on the recording — which said
/// "Network error" and nothing about which part, how many times, or what came
/// before. Every step now writes to both the unified log (visible in Console.app
/// or `log stream --predicate 'subsystem == "com.ojotennis.app"'`
/// with the phone attached) and a capped file in Documents, so the history of a
/// failed match survives the app being relaunched and can be read back later.
enum UploadLog {
    private static let logger = Logger(subsystem: "com.ojotennis.app", category: "upload")
    private static let queue = DispatchQueue(label: "UploadLog")

    /// Trimmed to roughly this, oldest first, so a chatty upload can't grow
    /// without bound on a phone that's already short on space for video.
    private static let maxBytes = 256 * 1024

    static var fileURL: URL { RecordingStore.documentsURL.appendingPathComponent("upload.log") }

    static func info(_ message: @autoclosure () -> String) {
        let text = message()
        logger.info("\(text, privacy: .public)")
        append("INFO ", text)
    }

    static func error(_ message: @autoclosure () -> String) {
        let text = message()
        logger.error("\(text, privacy: .public)")
        append("ERROR", text)
    }

    /// The tail of the log, for showing a failure's history in the app.
    static func recent(lines: Int = 40) -> String {
        queue.sync {
            guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return "" }
            return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
        }
    }

    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func append(_ level: String, _ message: String) {
        queue.async {
            let line = "\(stamp.string(from: Date())) \(level) \(message)\n"
            guard let data = line.data(using: .utf8) else { return }
            let url = fileURL
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: url, options: .atomic)
            }
            trimIfNeeded(url)
        }
    }

    /// Halve the file once it passes the cap, keeping the most recent lines.
    private static func trimIfNeeded(_ url: URL) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = attrs?[.size] as? Int, size > maxBytes else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let kept = text.split(separator: "\n", omittingEmptySubsequences: false)
        let tail = kept.suffix(kept.count / 2).joined(separator: "\n")
        try? tail.data(using: .utf8)?.write(to: url, options: .atomic)
    }
}
