import Foundation

/// Someone who played in a match — a linked Ojo user, or a guest (optionally
/// invited by email so they're linked when they sign up).
struct Participant: Codable, Equatable, Hashable {
    var userId: String?
    var displayName: String
    var email: String?

    /// Whether two entries are the same human.
    ///
    /// Account first, then address, then name — matching how the server decides
    /// it (`set_participants`). Comparing names alone put the same person on a
    /// match twice: an invite placeholder named after an address never equals
    /// the real profile name they get once they join.
    func isSamePerson(as other: Participant) -> Bool {
        if let mine = userId, let theirs = other.userId { return mine == theirs }
        if let mine = email?.lowercased(), let theirs = other.email?.lowercased() {
            return mine == theirs
        }
        // One of them is identified and the other isn't — only a name can tie
        // them together, and only when neither carries a competing identity.
        if userId != nil || other.userId != nil || email != nil || other.email != nil {
            return false
        }
        return displayName.equalsName(other.displayName)
    }
}

/// A match recorded on this phone. Lives in the local library until (and after)
/// it's uploaded, so you can always see what still needs to go up.
struct Recording: Identifiable, Codable, Equatable, Hashable {
    enum Status: String, Codable {
        case pending // recorded, not yet uploaded
        case uploading
        case uploaded
        case failed
    }

    let id: UUID
    var title: String
    /// File name within the app's Documents directory.
    var fileName: String
    var createdAt: Date
    var durationS: Double
    var sizeBytes: Int
    var status: Status
    var remoteVideoId: String?
    /// Who played. Optional in storage so older saved recordings still decode.
    var participants: [Participant]?
    /// 0...1 while uploading (not persisted meaningfully — reset on launch).
    var progress: Double
    /// Human-readable reason the last upload failed, if any.
    var uploadError: String?
    /// For cloud-only items (not recorded on this phone): a URL to fetch the poster
    /// thumbnail from the web. Transient — signed URLs expire, so it's re-fetched.
    var remoteThumbnailURL: String?

    init(
        id: UUID = UUID(),
        title: String,
        fileName: String,
        createdAt: Date,
        durationS: Double,
        sizeBytes: Int,
        status: Status = .pending,
        remoteVideoId: String? = nil,
        participants: [Participant]? = nil,
        progress: Double = 0,
        uploadError: String? = nil,
        remoteThumbnailURL: String? = nil
    ) {
        self.id = id
        self.title = title
        self.fileName = fileName
        self.createdAt = createdAt
        self.durationS = durationS
        self.sizeBytes = sizeBytes
        self.status = status
        self.remoteVideoId = remoteVideoId
        self.participants = participants
        self.progress = progress
        self.uploadError = uploadError
        self.remoteThumbnailURL = remoteThumbnailURL
    }

    /// True for a match that lives only in the cloud (no local file on this phone) —
    /// either uploaded then auto-removed to free space, or made on another device.
    var isCloudOnly: Bool { fileName.isEmpty }
}
