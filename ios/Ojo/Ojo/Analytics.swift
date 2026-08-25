import Foundation

/// Product events, sent to our own `/api/events`.
///
/// The counterpart to `UploadLog`, and worth being explicit about the
/// difference: `UploadLog` says in its own header that it *never transmits* —
/// it writes to the device's unified log and a capped local file, and that is
/// still true. This file is the one that sends, and it sends only the things
/// listed in `Event` below: which screens got used, whether an upload finished,
/// whether a match was shared. Never video, never a frame of one, never the
/// contents of a comment, never an address book, never a location, and never to
/// anybody but us.
///
/// There is no third-party SDK here on purpose. It keeps the App Store privacy
/// label at "Product Interaction / Analytics / Linked: Yes / Tracking: **No**"
/// with no App Tracking Transparency prompt, because nothing is shared with a
/// data broker and nothing follows anyone across other companies' apps. See
/// docs/APPSTORE.md §8 — if you add an SDK here, that section stops being true.
///
/// Design notes:
///   - Buffered to disk, so events survive the app being killed mid-flight, and
///     a match uploaded on a court with no signal still reports itself later.
///   - Flushed on background and foreground, never on a timer, never on the main
///     thread, and never in a way that can make the UI wait.
///   - Failure is always silent. An analytics event is not worth one line of a
///     user-visible error.
actor Analytics {
    static let shared = Analytics()

    /// The event vocabulary. Mirrors `web/lib/analytics/events.ts`, which is the
    /// list `/api/events` allow-lists against — a name that isn't there is
    /// dropped server-side, so the two files have to be changed together.
    enum Event: String {
        case recordingFinished = "recording_finished"
        case uploadStarted     = "upload_started"
        case uploadCompleted   = "upload_completed"
        case uploadFailed      = "upload_failed"
        case matchShared       = "match_shared"
        case shareLinkOpened   = "share_link_opened"
        case signupStarted     = "signup_started"
        case signupCompleted   = "signup_completed"
        case signIn            = "sign_in"
        case libraryAdd        = "library_add"
        case watchStarted      = "watch_started"
        case watchEnded        = "watch_ended"
        case analysisStarted   = "analysis_started"
    }

    /// Small typed values, so a prop can't accidentally become a nested object
    /// carrying something we didn't mean to send. The literal conformances are
    /// what let a call site read as `["channel": "link", "parts": 287]`.
    enum PropValue: Encodable, Sendable,
                    ExpressibleByStringLiteral,
                    ExpressibleByIntegerLiteral,
                    ExpressibleByFloatLiteral,
                    ExpressibleByBooleanLiteral {
        case string(String), int(Int), double(Double), bool(Bool)

        init(stringLiteral value: String) { self = .string(value) }
        init(integerLiteral value: Int) { self = .int(value) }
        init(floatLiteral value: Double) { self = .double(value) }
        init(booleanLiteral value: Bool) { self = .bool(value) }

        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let v): try c.encode(v)
            case .int(let v):    try c.encode(v)
            case .double(let v): try c.encode(v)
            case .bool(let v):   try c.encode(v)
            }
        }
    }

    private struct Payload: Encodable, Sendable {
        let name: String
        let platform = "ios"
        let sessionId: String
        let anonId: String
        let videoId: String?
        let appVersion: String
        let occurredAt: String
        let props: [String: PropValue]
    }

    private struct Envelope: Encodable, Sendable { let events: [Payload] }

    // MARK: - Opt-out

    private static let optOutKey = "ojo.analytics.optOut"

    /// UK GDPR Article 21: processing on a legitimate-interests basis has to be
    /// objectable-to. The Settings toggle writes this, and it is read on every
    /// single event rather than cached, so turning it off takes effect at once.
    ///
    /// Deliberately not an actor member: SettingsView needs to read and write it
    /// synchronously to drive a `Toggle`.
    nonisolated static var isOptedOut: Bool {
        get { UserDefaults.standard.bool(forKey: optOutKey) }
        set { UserDefaults.standard.set(newValue, forKey: optOutKey) }
    }

    // MARK: - Session identity

    /// A new session after this long in the background. Matches how the web
    /// client scopes a session to a browser tab: long enough that walking
    /// between courts isn't two sessions, short enough that tomorrow is.
    private static let sessionTimeout: TimeInterval = 30 * 60

    /// Both ids live in memory only and are regenerated with the session.
    ///
    /// Nothing identifying is written to the device, which is the point: there
    /// is no persistent identifier to declare on the privacy label, and no way
    /// for these rows to be joined up into a history of one phone. Signed-in
    /// events are attributed by the account server-side anyway, from the Bearer
    /// token — the client never sends a user id and could not be believed if it
    /// did.
    private var currentSession = UUID().uuidString
    private var currentAnon = UUID().uuidString
    private var lastEventAt = Date()

    private func sessionId() -> String {
        if Date().timeIntervalSince(lastEventAt) > Self.sessionTimeout {
            currentSession = UUID().uuidString
            currentAnon = UUID().uuidString
        }
        lastEventAt = Date()
        return currentSession
    }

    private static let appVersion: String = {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }()

    // MARK: - Buffer

    /// Roughly a fortnight of heavy use. Past this the oldest go, because a
    /// buffer that grows without bound on a phone already short of space for
    /// video is a worse bug than a missing statistic.
    private static let maxBuffered = 200

    private var buffer: [Payload] = []
    private var loaded = false
    /// An actor releases its isolation across `await`, so a flush triggered by
    /// backgrounding and one triggered by the buffer filling up can interleave
    /// — both taking the same 20 events and sending them twice. This is what
    /// stops that.
    private var sending = false
    /// Flush once a handful have gathered, so an active session doesn't sit on
    /// them until it is backgrounded.
    private static let flushThreshold = 10

    private static var fileURL: URL {
        RecordingStore.documentsURL.appendingPathComponent("analytics.json")
    }

    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // MARK: - Recording

    /// Fire and forget from anywhere, including the main actor.
    ///
    /// Synchronous, returns immediately, and hops onto a detached task to do the
    /// actual work — so no caller ever awaits analytics.
    nonisolated static func track(
        _ event: Event,
        videoId: String? = nil,
        props: [String: PropValue] = [:]
    ) {
        guard !isOptedOut else { return }
        Task.detached(priority: .background) {
            await shared.record(event, videoId: videoId, props: props)
        }
    }

    /// Flush anything buffered. Called when the app backgrounds or foregrounds.
    nonisolated static func flush() {
        guard !isOptedOut else { return }
        Task.detached(priority: .background) { await shared.send() }
    }

    /// Drop everything held locally. Called on sign-out and on account deletion,
    /// so the next account can't inherit the last one's unsent events — the same
    /// reason `AppCache` is cleared there.
    nonisolated static func reset() {
        Task.detached(priority: .background) { await shared.clear() }
    }

    private func record(_ event: Event, videoId: String?, props: [String: PropValue]) async {
        guard !Self.isOptedOut else { return }
        loadIfNeeded()

        buffer.append(Payload(
            name: event.rawValue,
            sessionId: sessionId(),
            anonId: currentAnon,
            videoId: videoId,
            appVersion: Self.appVersion,
            occurredAt: Self.stamp.string(from: Date()),
            props: props
        ))
        if buffer.count > Self.maxBuffered {
            buffer.removeFirst(buffer.count - Self.maxBuffered)
        }
        persist()

        if buffer.count >= Self.flushThreshold { await send() }
    }

    private func clear() {
        buffer = []
        loaded = true
        try? FileManager.default.removeItem(at: Self.fileURL)
    }

    // MARK: - Sending

    private func send() async {
        guard !Self.isOptedOut else { return clear() }
        loadIfNeeded()
        guard !buffer.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }

        // Sent in batches because the endpoint caps one request at 20; anything
        // left over goes on the next flush rather than being dropped.
        let batch = Array(buffer.prefix(20))
        guard let body = try? JSONEncoder().encode(Envelope(events: batch)) else {
            // Unencodable means it will never encode. Drop it rather than
            // retrying the same failure until the end of time.
            buffer.removeFirst(batch.count)
            persist()
            return
        }

        var request = URLRequest(url: Config.apiBaseURL.appendingPathComponent("api/events"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        // Signed-in events are attributed from this token, server-side. Without
        // one the event still counts — it is just anonymous, which is exactly
        // right for the sign-up screen.
        if let token = await Supa.accessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.timeoutInterval = 15

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else {
            return // Offline. Keep them; the next flush tries again.
        }
        // 2xx accepted. 4xx means the server will never accept these, so drop
        // them; only 5xx and transport errors are worth another go.
        guard (200..<300).contains(http.statusCode) || (400..<500).contains(http.statusCode) else {
            return
        }
        buffer.removeFirst(batch.count)
        persist()
    }

    // MARK: - Disk

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: Self.fileURL),
              let saved = try? JSONDecoder().decode([StoredPayload].self, from: data) else { return }
        buffer = saved.map(\.payload)
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(buffer.map(StoredPayload.init(payload:))) else { return }
        // `.completeFileProtectionUntilFirstUserAuthentication` rather than the
        // default: the buffer is written while the app is backgrounded, when a
        // stricter class would make the file unwritable.
        try? data.write(to: Self.fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Round-trips a `Payload` through disk. `Payload` is encode-only (its
    /// `platform` is a constant), so decoding needs its own shape.
    private struct StoredPayload: Codable, Sendable {
        let name: String
        let sessionId: String
        let anonId: String
        let videoId: String?
        let appVersion: String
        let occurredAt: String
        let props: [String: PropValue]

        init(payload: Payload) {
            name = payload.name
            sessionId = payload.sessionId
            anonId = payload.anonId
            videoId = payload.videoId
            appVersion = payload.appVersion
            occurredAt = payload.occurredAt
            props = payload.props
        }

        var payload: Payload {
            Payload(name: name, sessionId: sessionId, anonId: anonId, videoId: videoId,
                    appVersion: appVersion, occurredAt: occurredAt, props: props)
        }
    }
}

extension Analytics.PropValue: Decodable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else { self = .string(try c.decode(String.self)) }
    }
}
