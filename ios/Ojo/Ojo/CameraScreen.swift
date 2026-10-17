import AVFoundation
import SwiftUI
import UIKit

/// The fullscreen camera — presented as a modal from the Record button. This is
/// the app's primary action, so the capture behavior here is deliberately
/// unchanged from the original recorder: the preview stays mounted the whole
/// time (tearing it down mid-record would finalize the recording), a dark
/// low-power screen overlays while recording, the screen is kept awake + dimmed,
/// and a rotate hint flashes on start.
struct CameraScreen: View {
    @ObservedObject var library: RecordingLibrary
    /// Called once a freshly recorded match has been filed into the library.
    var onFinished: (Recording) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = CameraRecorder()
    @State private var showRotateHint = false
    @State private var savedBrightness: CGFloat = 1.0
    @StateObject private var budget = RecordingBudget()
    /// Shown once when the camera opens, if storage or battery is under an hour.
    @State private var lowBudget: String?

    var body: some View {
        ZStack(alignment: .bottom) {
            CameraPreview(session: recorder.session)
                .ignoresSafeArea()

            if recorder.isRecording {
                LowPowerRecordingView(startedAt: recorder.recordingStartedAt,
                                      remaining: budget.remainingSeconds.map(RecordingBudget.duration))
                    .ignoresSafeArea()
                    .transition(.opacity)
            }

            if showRotateHint {
                RotateHint()
                    .padding(.bottom, 150)
                    .transition(.opacity)
            }

            RecordButton(isRecording: recorder.isRecording) {
                recorder.isRecording ? recorder.stop() : recorder.start()
            }
            .padding(.bottom, 44)
        }
        // Close (X) to leave the camera — hidden while recording so it can't be
        // tapped by accident mid-match.
        .overlay(alignment: .topLeading) {
            if !recorder.isRecording {
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(.black.opacity(0.35), in: Circle())
                }
                .padding(.top, 8)
                .padding(.leading, 12)
                .accessibilityLabel("Close camera")
            }
        }
        // How long this phone can record for, before anyone presses the button.
        .overlay(alignment: .top) {
            if !recorder.isRecording {
                RecordingBudgetPill(budget: budget)
                    .padding(.top, 14)
                    .transition(.opacity)
                    // Its own alert, so it can't collide with the recorder's.
                    .alert("Less than an hour of recording",
                           isPresented: Binding(get: { lowBudget != nil }, set: { if !$0 { lowBudget = nil } })) {
                        Button("Record anyway", role: .cancel) { lowBudget = nil }
                    } message: {
                        Text(lowBudget ?? "")
                    }
            }
        }
        .onAppear {
            budget.start()
            lowBudget = budget.warning
            AVCaptureDevice.requestAccess(for: .video) { _ in
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    Task { @MainActor in recorder.configure() }
                }
            }
        }
        .onDisappear { budget.stop() }
        .onChange(of: recorder.isRecording) { _, recording in
            UIApplication.shared.isIdleTimerDisabled = recording
            if recording {
                savedBrightness = UIScreen.main.brightness
                UIScreen.main.brightness = 0.1
                withAnimation { showRotateHint = true }
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    withAnimation { showRotateHint = false }
                }
            } else {
                UIScreen.main.brightness = savedBrightness
            }
        }
        // When a recording finishes, file it and jump straight to its Watch screen
        // (where you review the footage, name it, tag players and share).
        .onChange(of: recorder.lastFileURL) { _, newURL in
            // The file is already in Documents under the id capture journalled, so
            // this only indexes it — and adopting by that id means a recording the
            // crash sweep got to first is reused rather than duplicated.
            guard newURL != nil, let id = recorder.lastRecordingId else { return }
            // Named and dated by when play began, not when it stopped.
            guard let recording = library.adopt(
                id: id,
                fileName: "\(id.uuidString).mov",
                title: "",
                durationS: recorder.lastDuration,
                createdAt: recorder.lastStartedAt ?? Date()
            ) else { return }
            library.justRecorded = recording.id
            onFinished(recording)
        }
        // Storage problems the recorder can't resolve on its own: no room to
        // start, or a match iOS stopped early to keep the disk from filling.
        .alert(
            "Storage",
            isPresented: Binding(
                get: { recorder.alert != nil },
                set: { if !$0 { recorder.alert = nil } }
            )
        ) {
            Button("OK", role: .cancel) { recorder.alert = nil }
        } message: {
            Text(recorder.alert ?? "")
        }
    }
}
