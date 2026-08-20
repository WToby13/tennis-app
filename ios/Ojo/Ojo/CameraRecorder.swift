import AVFoundation
import Combine
import CoreMedia
import Foundation
import OSLog

/// Captures video+audio to a local .mov using AVFoundation. Writing straight to a
/// file (rather than buffering in memory) is what makes a 2-hour recording viable.
///
/// Capture is locked to **landscape**, since the phone is laid horizontally at the
/// back of the court — so the saved video is upright regardless of how the phone is
/// held when recording starts. All session work runs on a dedicated serial queue,
/// and `isRecording` is driven by the real delegate callbacks.
final class CameraRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    /// When the current recording started (nil when idle) — drives the on-screen timer.
    @Published var recordingStartedAt: Date?
    /// Set only when the finished file is actually usable — a recording that
    /// failed outright must not be filed into the library as a broken match.
    @Published var lastFileURL: URL?
    @Published var lastDuration: Double = 0
    /// Something the user needs to know: not enough space to start, or a recording
    /// that iOS stopped early because the disk filled. Cleared when dismissed.
    @Published var alert: String?

    let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let sessionQueue = DispatchQueue(label: "camera.session.queue")
    private var isConfigured = false
    private static let log = Logger(subsystem: "com.ojotennis.app", category: "camera")

    /// Video bitrate for capture.
    ///
    /// Left to AVFoundation's default for `.hd1920x1080`, this was **15.4 Mbps**
    /// (measured: a 61.8-minute match came out at 7.14 GB, and a 33-minute one at
    /// 3.6 GB — the same rate). That's a lot of bytes for a fixed wide shot of a
    /// court, and it has real costs: it filled a 64 GB phone, and it's an hour of
    /// phone-radio upload per match.
    ///
    /// 8 Mbps is the streaming-grade rate for 1080p30 H.264 and roughly halves
    /// all of that. The margin for the thing we actually care about is large:
    /// `web/lib/analysisProxy.ts` establishes empirically that the AI breakdown is
    /// *indistinguishable* at 1080p ~1.7 Mbps, so analysis has ~4.7× headroom
    /// here. Resolution is the axis that matters for seeing the ball, and that is
    /// unchanged.
    static let videoBitRate = 8_000_000

    /// Bytes a second of recording costs, video plus a margin for AAC audio and
    /// container overhead. Used to tell the user how long they can record.
    private static var bytesPerSecond: Int { videoBitRate / 8 * 11 / 10 }

    /// Never let a recording take the phone all the way down. `AVCaptureFileOutput`
    /// enforces this itself and stops cleanly — the file written up to that point
    /// stays valid — which is far better than the disk filling under us. It also
    /// leaves the uploader room to slice parts afterwards.
    private static let diskReserve = 700 * 1024 * 1024

    /// Below this much *recordable* time, starting isn't worth it — you'd be
    /// stopped again within minutes, mid-match.
    private static let minimumRecordableSeconds = 10 * 60

    /// Free space on the volume, counting what the system would purge for us.
    private static func freeBytes() -> Int? {
        let values = try? FileManager.default.temporaryDirectory.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage.map(Int.init)
    }

    /// Roughly how long can still be recorded before the reserve is reached.
    static func recordableSeconds() -> Int? {
        guard let free = freeBytes() else { return nil }
        return max(0, (free - diskReserve) / bytesPerSecond)
    }

    func configure() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard !self.isConfigured else {
                if !self.session.isRunning { self.session.startRunning() }
                return
            }
            self.isConfigured = true

            self.session.beginConfiguration()

            // Prefer the 0.5× ultra-wide lens — from one fixed spot behind the court it
            // frames the whole thing. Fall back to the standard wide-angle on phones
            // without an ultra-wide camera (e.g. iPhone SE).
            let camera = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            if let camera,
               let videoInput = try? AVCaptureDeviceInput(device: camera),
               self.session.canAddInput(videoInput) {
                self.session.addInput(videoInput)
            }
            if let mic = AVCaptureDevice.default(for: .audio),
               let audioInput = try? AVCaptureDeviceInput(device: mic),
               self.session.canAddInput(audioInput) {
                self.session.addInput(audioInput)
            }
            if self.session.canAddOutput(self.movieOutput) {
                self.session.addOutput(self.movieOutput)
            }

            // 1080p is plenty for match review and roughly halves encode load,
            // heat and file size versus 4K over a 2-hour record.
            self.session.sessionPreset =
                self.session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .high

            self.session.commitConfiguration()

            // Stop cleanly before the volume fills, keeping what was recorded.
            self.movieOutput.minFreeDiskSpaceLimit = Int64(Self.diskReserve)

            if let connection = self.movieOutput.connection(with: .video) {
                // Lock to landscape (0°) so footage is upright with the phone horizontal.
                Self.setLandscape(connection)

                // Only keys the output actually advertises may be set here; an
                // unsupported one is a hard error rather than something ignored.
                let supported = self.movieOutput.supportedOutputSettingsKeys(for: connection)
                var settings: [String: Any] = [:]
                // Force H.264 rather than the iPhone default (HEVC), which Chrome/Firefox can't play.
                if self.movieOutput.availableVideoCodecTypes.contains(.h264),
                   supported.contains(AVVideoCodecKey) {
                    settings[AVVideoCodecKey] = AVVideoCodecType.h264
                }
                if supported.contains(AVVideoCompressionPropertiesKey) {
                    settings[AVVideoCompressionPropertiesKey] = [
                        AVVideoAverageBitRateKey: Self.videoBitRate,
                    ]
                }
                if !settings.isEmpty {
                    self.movieOutput.setOutputSettings(settings, for: connection)
                }
                // Read back what actually stuck, so the capture rate is verifiable
                // from the log rather than assumed.
                let applied = self.movieOutput.outputSettings(for: connection)
                Self.log.info("capture settings applied: \(String(describing: applied), privacy: .public)")
            }

            self.session.startRunning()
        }
    }

    /// Point a connection (capture or preview) at landscape orientation.
    static func setLandscape(_ connection: AVCaptureConnection) {
        if #available(iOS 17.0, *) {
            if connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = .landscapeRight
        }
    }

    func start() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.session.isRunning { self.session.startRunning() }
            guard !self.movieOutput.isRecording else { return }

            // Refuse rather than start a match that dies a few minutes in. This is
            // how the phone ended up full in the first place: an hour of capture
            // with nothing checking there was anywhere to put it.
            if let seconds = Self.recordableSeconds(), seconds < Self.minimumRecordableSeconds {
                let free = Self.freeBytes() ?? 0
                let needed = Self.diskReserve + Self.minimumRecordableSeconds * Self.bytesPerSecond
                Self.log.error("refusing to record: \(free) bytes free, need \(needed)")
                DispatchQueue.main.async {
                    self.alert = "Not enough storage to record. There's "
                        + "\(Self.readable(free)) free and a match needs about "
                        + "\(Self.readable(needed)) to get going — around "
                        + "\(Self.readable(Self.bytesPerSecond * 3600)) per hour. Free up some space and try again."
                }
                return
            }
            if let seconds = Self.recordableSeconds() {
                Self.log.info("starting recording with room for ~\(seconds / 60) min")
            }

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("match-\(Int(Date().timeIntervalSince1970)).mov")
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    private static func readable(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self, self.movieOutput.isRecording else { return }
            self.movieOutput.stopRecording()
        }
    }
}

extension CameraRecorder: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        DispatchQueue.main.async {
            self.recordingStartedAt = Date()
            self.isRecording = true
        }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        // A non-nil error doesn't always mean the file is rubbish: hitting the
        // free-space limit stops the recording but leaves everything up to that
        // point playable, and AVFoundation says so via this flag. The error used
        // to be discarded entirely, so a match cut short looked completely normal
        // and a genuinely failed one was filed as a broken recording.
        let ns = error as NSError?
        let usable = ns.map { $0.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false } ?? true
        if let ns { Self.log.error("recording finished with error \(ns.code): \(ns.localizedDescription, privacy: .public), usable: \(usable)") }

        DispatchQueue.main.async {
            let started = self.recordingStartedAt
            self.isRecording = false
            self.recordingStartedAt = nil
            self.lastDuration = started.map { Date().timeIntervalSince($0) } ?? 0

            guard usable else {
                try? FileManager.default.removeItem(at: outputFileURL)
                self.alert = "The recording couldn't be saved: \(ns?.localizedDescription ?? "unknown error")"
                return
            }
            if ns != nil {
                self.alert = "The phone ran out of storage, so recording stopped early. "
                    + "Everything up to that point was saved — upload it to free the space back up."
            }
            self.lastFileURL = outputFileURL
        }
    }
}
