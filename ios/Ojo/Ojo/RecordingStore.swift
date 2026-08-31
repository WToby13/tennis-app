import Foundation

/// File-backed source of truth for the local recordings index, shared by the
/// main-thread `RecordingLibrary` and the `BackgroundUploader` (which can run in
/// a relaunched process, off the main thread). Marked `nonisolated` because it's
/// deliberately thread-agnostic: all file access is serialized on `queue`, and
/// mutations post `didChange` so the UI can refresh.
enum RecordingStore {
    nonisolated static let didChange = Notification.Name("RecordingStoreDidChange")

    nonisolated private static let queue = DispatchQueue(label: "RecordingStore")

    nonisolated static var documentsURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    nonisolated private static var indexURL: URL {
        documentsURL.appendingPathComponent("recordings.json")
    }
    nonisolated private static var inProgressURL: URL {
        documentsURL.appendingPathComponent("in-progress.json")
    }

    /// A recording that has started but not yet been filed.
    ///
    /// Capture only became visible to the app in the *finish* delegate callback,
    /// so a match that never finished — the phone died, iOS killed us, the battery
    /// went — left a multi-gigabyte file on disk that nothing referenced. It was
    /// invisible in the app while still counting against storage, and the only
    /// clue was the app's size in Settings. This note is written the moment
    /// capture begins, so the next launch knows that file is a real match.
    nonisolated struct InProgress: Codable {
        let id: UUID
        let fileName: String
        let startedAt: Date
    }

    nonisolated static func beginRecording(_ note: InProgress) {
        queue.sync {
            if let data = try? JSONEncoder().encode(note) {
                try? data.write(to: inProgressURL, options: .atomic)
            }
        }
    }

    nonisolated static func inProgressRecording() -> InProgress? {
        queue.sync {
            guard let data = try? Data(contentsOf: inProgressURL) else { return nil }
            return try? JSONDecoder().decode(InProgress.self, from: data)
        }
    }

    nonisolated static func clearInProgress() {
        queue.sync { try? FileManager.default.removeItem(at: inProgressURL) }
    }

    nonisolated static func load() -> [Recording] {
        queue.sync {
            guard let data = try? Data(contentsOf: indexURL),
                  let saved = try? JSONDecoder().decode([Recording].self, from: data) else { return [] }
            return saved
        }
    }

    nonisolated static func save(_ recordings: [Recording]) {
        queue.sync {
            if let data = try? JSONEncoder().encode(recordings) {
                try? data.write(to: indexURL, options: .atomic)
            }
        }
        NotificationCenter.default.post(name: didChange, object: nil)
    }

    /// Mutate a single recording by id (no-op if it's gone) and persist.
    nonisolated static func update(id: UUID, _ mutate: (inout Recording) -> Void) {
        var changed = false
        queue.sync {
            guard let data = try? Data(contentsOf: indexURL),
                  var saved = try? JSONDecoder().decode([Recording].self, from: data),
                  let i = saved.firstIndex(where: { $0.id == id }) else { return }
            mutate(&saved[i])
            if let out = try? JSONEncoder().encode(saved) {
                try? out.write(to: indexURL, options: .atomic)
                changed = true
            }
        }
        if changed { NotificationCenter.default.post(name: didChange, object: nil) }
    }
}
