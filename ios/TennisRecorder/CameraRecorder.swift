import AVFoundation
import Foundation

/// Captures video+audio to a local .mov using AVFoundation. Writing straight to a
/// file (rather than buffering in memory) is what makes a 2-hour recording viable.
@MainActor
final class CameraRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var lastFileURL: URL?
    @Published var lastDuration: Double = 0

    let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private var startTime: Date?

    func configure() {
        session.beginConfiguration()
        session.sessionPreset = .high

        if let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let videoInput = try? AVCaptureDeviceInput(device: camera),
           session.canAddInput(videoInput) {
            session.addInput(videoInput)
        }
        if let mic = AVCaptureDevice.default(for: .audio),
           let audioInput = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(audioInput) {
            session.addInput(audioInput)
        }
        if session.canAddOutput(movieOutput) {
            session.addOutput(movieOutput)
        }
        session.commitConfiguration()
    }

    func start() {
        guard !movieOutput.isRecording else { return }
        Task.detached { self.session.startRunning() }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("match-\(Int(Date().timeIntervalSince1970)).mov")
        startTime = Date()
        movieOutput.startRecording(to: url, recordingDelegate: self)
        isRecording = true
    }

    func stop() {
        guard movieOutput.isRecording else { return }
        movieOutput.stopRecording()
        isRecording = false
    }
}

extension CameraRecorder: AVCaptureFileOutputRecordingDelegate {
    nonisolated func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        Task { @MainActor in
            self.lastDuration = self.startTime.map { Date().timeIntervalSince($0) } ?? 0
            self.lastFileURL = outputFileURL
        }
    }
}
