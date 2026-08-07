import AVFoundation
import Combine
import CoreMedia
import Foundation

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
    @Published var lastFileURL: URL?
    @Published var lastDuration: Double = 0

    let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let sessionQueue = DispatchQueue(label: "camera.session.queue")
    private var isConfigured = false

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

            if let connection = self.movieOutput.connection(with: .video) {
                // Lock to landscape (0°) so footage is upright with the phone horizontal.
                Self.setLandscape(connection)
                // Force H.264 rather than the iPhone default (HEVC), which Chrome/Firefox can't play.
                if self.movieOutput.availableVideoCodecTypes.contains(.h264) {
                    self.movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
                }
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
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("match-\(Int(Date().timeIntervalSince1970)).mov")
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
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
        DispatchQueue.main.async {
            let started = self.recordingStartedAt
            self.isRecording = false
            self.recordingStartedAt = nil
            self.lastDuration = started.map { Date().timeIntervalSince($0) } ?? 0
            self.lastFileURL = outputFileURL
        }
    }
}
