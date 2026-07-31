import AVFoundation
import SwiftUI

struct ContentView: View {
    @StateObject private var auth = AuthModel()

    var body: some View {
        if auth.isSignedIn {
            RecorderView(auth: auth)
        } else {
            LoginView(auth: auth)
        }
    }
}

struct RecorderView: View {
    @ObservedObject var auth: AuthModel
    @StateObject private var recorder = CameraRecorder()
    @StateObject private var uploader = MultipartUploader()
    @State private var title = ""

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Spacer()
                Button("Sign out") { Task { await auth.signOut() } }.font(.footnote)
            }

            CameraPreview(session: recorder.session)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(alignment: .topLeading) {
                    if recorder.isRecording {
                        Label("REC", systemImage: "record.circle")
                            .padding(8).background(.red.opacity(0.85))
                            .foregroundStyle(.white).clipShape(Capsule()).padding(10)
                    }
                }

            TextField("Match title", text: $title)
                .textFieldStyle(.roundedBorder)

            if recorder.isRecording {
                Button("Stop recording", role: .destructive) { recorder.stop() }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Start recording") { recorder.start() }
                    .buttonStyle(.borderedProminent)
            }

            if let fileURL = recorder.lastFileURL, !recorder.isRecording {
                Button("Upload last recording") {
                    Task {
                        await uploader.upload(
                            fileURL: fileURL,
                            title: title.isEmpty ? "Untitled match" : title,
                            durationS: recorder.lastDuration
                        )
                    }
                }
                .buttonStyle(.bordered)

                if uploader.state != "idle" {
                    ProgressView(value: uploader.progress)
                    Text(uploader.state).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .onAppear {
            AVCaptureDevice.requestAccess(for: .video) { _ in
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    Task { @MainActor in recorder.configure() }
                }
            }
        }
    }
}

/// UIKit bridge for the live camera preview.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.videoPreviewLayer.session = session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
