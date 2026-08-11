import AVFoundation
import SwiftUI
import UIKit

// Shared building blocks used across the app: the shutter + recording overlays
// (CameraScreen), the match thumbnail and progress bar (LibraryView), the
// confirm dialog and share sheet, and the camera preview bridge. The top-level
// containers (tab bar, camera, library, watch) live in their own files.

// MARK: - Shutter button

struct RecordButton: View {
    let isRecording: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(.ultraThinMaterial).frame(width: 78, height: 78)
                Circle().stroke(.white.opacity(0.9), lineWidth: 4).frame(width: 78, height: 78)
                RoundedRectangle(cornerRadius: isRecording ? 6 : 30)
                    .fill(.red)
                    .frame(width: isRecording ? 32 : 60, height: isRecording ? 32 : 60)
                    .animation(.easeInOut(duration: 0.2), value: isRecording)
            }
        }
        .accessibilityLabel(isRecording ? "Stop recording" : "Start recording")
    }
}

// MARK: - REC + timer badge

struct RecTimerBadge: View {
    let startedAt: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Label(elapsed(now: context.date), systemImage: "record.circle.fill")
                .font(.callout.monospacedDigit().bold())
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(.red.opacity(0.9), in: Capsule())
                .foregroundStyle(.white)
        }
    }

    private func elapsed(now: Date) -> String {
        let seconds = Int(max(0, now.timeIntervalSince(startedAt ?? now)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

// MARK: - Low-power recording screen

/// Shown in place of the live preview while recording: a black screen (the preview
/// layer is torn down to save the GPU) with just the REC timer. Paired with dimming
/// the display in `CameraScreen`, this keeps long recordings cool and battery-light.
struct LowPowerRecordingView: View {
    let startedAt: Date?

    var body: some View {
        ZStack {
            Color.black
            VStack(spacing: 14) {
                RecTimerBadge(startedAt: startedAt)
                Text("Screen dimmed to save battery.\nRecording continues — tap the button to stop.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.45))
                    .multilineTextAlignment(.center)
            }
            .padding(.bottom, 60)
        }
    }
}

// MARK: - Rotate hint

struct RotateHint: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "rotate.right.fill")
                .font(.system(size: 28, weight: .semibold))
            Text("Place phone horizontally at the back of the court")
                .font(.footnote.weight(.medium))
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(16)
        .frame(maxWidth: 260)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Recording thumbnail

/// A recording's poster frame with a play glyph. Prefers the locally cached/generated
/// frame; for cloud-only matches it fetches the poster from the web. Falls back to a
/// dark tile while loading or if no frame can be read.
struct RecordingThumbnail: View {
    let recording: Recording
    let localURL: URL
    let hasLocal: Bool
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.black
                Image(systemName: "video.fill")
                    .foregroundStyle(.white.opacity(0.3))
            }

            Image(systemName: "play.circle.fill")
                .font(.title3)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white)
                .shadow(radius: 2)
        }
        .task(id: recording.id) {
            if let cached = Thumbnailer.cached(for: recording.id) {
                image = cached
            } else if hasLocal {
                image = await Thumbnailer.thumbnail(for: recording.id, videoURL: localURL)
            } else if let remote = recording.remoteThumbnailURL, let url = URL(string: remote) {
                image = await Thumbnailer.fetchRemote(for: recording.id, url: url)
            }
        }
    }
}

// MARK: - Progress bar

/// Upload progress as a plain track.
///
/// Not `ProgressView(value:)`: the linear style carries an ideal width of its own,
/// which is wider than a match card's column — enough to push the card past its
/// grid cell and out over its neighbour. A `GeometryReader` claims the width it's
/// given and asks for nothing, so the card can't be stretched by its own progress.
struct ProgressBar: View {
    let value: Double
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface2)
                Capsule().fill(Theme.accent)
                    .frame(width: geo.size.width * min(max(value, 0), 1))
            }
        }
        .frame(height: height)
    }
}

// MARK: - Confirm dialog

/// A destructive confirmation in the app's own clothes rather than a system alert —
/// deleting a match is the one irreversible thing in here, so it's worth the
/// moment it takes to read.
struct OjoConfirm: View {
    let title: String
    let message: String
    var confirmTitle = "Yes"
    var cancelTitle = "No"
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture(perform: onCancel)

            VStack(spacing: 14) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 10) {
                    Button(action: onCancel) {
                        Text(cancelTitle)
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall)
                                .stroke(Theme.border, lineWidth: 1.5))
                            .foregroundStyle(Theme.text)
                    }
                    Button(action: onConfirm) {
                        Text(confirmTitle)
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Theme.danger, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                            .foregroundStyle(Theme.text)
                    }
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
            .padding(20)
            .frame(maxWidth: 320)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.4), radius: 20)
            .padding(24)
        }
    }
}

// MARK: - iOS share sheet

/// What the system share sheet is being handed. Wrapped in an `Identifiable` box
/// so it can drive `.sheet(item:)` — the URL is resolved asynchronously (a share
/// link has to be minted first), so there's nothing to present until it arrives.
struct SharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

/// The system share sheet, so a match leaves the app the same way anything else
/// does — Messages, AirDrop, copy, whatever the person actually uses.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Status badge + formatting helpers

struct StatusBadge: View {
    let status: Recording.Status

    var body: some View {
        Text(statusText(status).uppercased())
            .font(.caption2.bold())
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .pending: return .orange
        case .uploading: return .blue
        case .uploaded: return .green
        case .failed: return .red
        }
    }
}

func statusText(_ status: Recording.Status) -> String {
    switch status {
    case .pending: return "Not uploaded"
    case .uploading: return "Uploading"
    case .uploaded: return "Uploaded"
    case .failed: return "Failed"
    }
}

/// h:mm:ss for anything over an hour, m:ss below — a two-hour match read as
/// "127:14" before, which is a number nobody parses as a duration.
func durationString(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds > 0 else { return "0:00" }
    let total = Int(seconds)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, secs)
        : String(format: "%d:%02d", minutes, secs)
}

func sizeString(_ bytes: Int) -> String {
    let mb = Double(bytes) / 1_000_000
    if mb >= 1000 { return String(format: "%.1f GB", mb / 1000) }
    return mb >= 1 ? String(format: "%.0f MB", mb) : "<1 MB"
}

/// Parse an ISO-8601 timestamp from the web API (with or without fractional
/// seconds), falling back to now.
func parseISODate(_ iso: String?) -> Date {
    guard let iso else { return Date() }
    let withFractional = ISO8601DateFormatter()
    withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFractional.date(from: iso) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: iso) ?? Date()
}

// MARK: - Camera preview bridge

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.videoPreviewLayer.session = session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        if let connection = view.videoPreviewLayer.connection {
            CameraRecorder.setLandscape(connection)
        }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        if let connection = uiView.videoPreviewLayer.connection {
            CameraRecorder.setLandscape(connection)
        }
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
