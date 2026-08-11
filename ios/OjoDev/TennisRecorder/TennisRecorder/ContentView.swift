import AVFoundation
import SwiftUI
import UIKit

// Shared building blocks used across the app: the shutter + recording overlays
// (CameraScreen), the match row / thumbnail / player / edit shelf (MatchesView),
// and the camera preview bridge. The top-level containers (tab bar, camera,
// library) live in their own files.

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

// MARK: - In-app player loader (resolves local file or cloud playback URL)

/// Presents the in-app player for a recording. Local matches play straight from the
/// file; cloud-only matches resolve a signed playback URL from the web first.
struct PlayerLoader: View {
    let recording: Recording
    @ObservedObject var library: RecordingLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var url: URL?
    @State private var errorText: String?

    var body: some View {
        if let url {
            PlayerView(url: url, title: recording.title)
        } else {
            ZStack {
                Color.black.ignoresSafeArea()
                if let errorText {
                    Text(errorText)
                        .foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                        .padding(32)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .overlay(alignment: .topLeading) {
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 30))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.white)
                        .padding(16)
                }
            }
            .task { await resolve() }
        }
    }

    private func resolve() async {
        if library.hasLocalFile(recording) {
            url = library.fileURL(for: recording)
            return
        }
        guard let videoId = recording.remoteVideoId else {
            errorText = "This match isn't available to play."
            return
        }
        let api = UploadAPI()
        do {
            let detail = try await api.getVideo(videoId: videoId)
            if let playback = detail.playbackUrl {
                url = api.absolutePartURL(playback)
            } else {
                errorText = "This match isn't ready to play yet."
            }
        } catch {
            errorText = "Couldn't load this match.\nCheck your connection and try again."
        }
    }
}

// MARK: - Edit shelf (name / details / share)

struct EditSheet: View {
    let recording: Recording
    @ObservedObject var library: RecordingLibrary
    let onDone: () -> Void
    @State private var name: String
    @State private var playing = false
    @State private var players: [Participant]
    @State private var query = ""
    @State private var searchResults: [UserResult] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var guestName = ""
    @State private var guestEmail = ""
    private let api = UploadAPI()

    init(recording: Recording, library: RecordingLibrary, onDone: @escaping () -> Void) {
        self.recording = recording
        self.library = library
        self.onDone = onDone
        _name = State(initialValue: recording.title == "Untitled match" ? "" : recording.title)
        _players = State(initialValue: recording.participants ?? [])
    }

    /// Latest state for this recording (status/progress can change while open).
    private var current: Recording {
        library.displayed.first { $0.id == recording.id } ?? recording
    }

    var body: some View {
        NavigationStack {
            Form {
                // All the "good" actions together at the top: play, then upload/share.
                Section {
                    Button {
                        playing = true
                    } label: {
                        Label("Play", systemImage: "play.circle.fill")
                    }

                    switch current.status {
                    case .pending, .failed:
                        Button {
                            save()
                            let recording = current
                            Task { await library.upload(recording) }
                            onDone()
                        } label: {
                            Label(current.status == .failed ? "Retry upload" : "Upload now",
                                  systemImage: "arrow.up.circle.fill")
                        }
                    case .uploading:
                        HStack {
                            ProgressView(value: current.progress)
                            Text("\(Int(current.progress * 100))%").font(.caption).foregroundStyle(.secondary)
                        }
                    case .uploaded:
                        if let videoId = current.remoteVideoId {
                            Link(destination: Config.watchURL(videoId: videoId)) {
                                Label("View on web", systemImage: "play.circle")
                            }
                            ShareLink(item: Config.watchURL(videoId: videoId)) {
                                Label("Share link", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                }

                Section("Name") {
                    TextField("Untitled match", text: $name)
                        .submitLabel(.done)
                }

                Section("Players") {
                    ForEach(Array(players.enumerated()), id: \.offset) { idx, p in
                        HStack {
                            Text(p.displayName)
                            if p.userId == nil {
                                Text(p.email == nil ? "guest" : "invited")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(role: .destructive) {
                                players.remove(at: idx)
                            } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                        }
                    }

                    TextField("Search Ojo players", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: query) { _, q in
                            searchTask?.cancel()
                            searchTask = Task {
                                let results = (try? await api.searchUsers(q)) ?? []
                                if !Task.isCancelled {
                                    await MainActor.run { searchResults = results }
                                }
                            }
                        }

                    ForEach(searchResults) { u in
                        Button {
                            if !players.contains(where: { $0.userId == u.id }) {
                                players.append(Participant(userId: u.id, displayName: u.displayName, email: nil))
                            }
                            query = ""
                            searchResults = []
                        } label: {
                            Label(u.displayName, systemImage: "plus.circle")
                        }
                    }
                }

                Section("Add someone not on Ojo") {
                    TextField("Name", text: $guestName)
                    TextField("Email (optional — to invite)", text: $guestEmail)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Add guest") {
                        let n = guestName.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !n.isEmpty else { return }
                        let email = guestEmail.trimmingCharacters(in: .whitespacesAndNewlines)
                        players.append(Participant(userId: nil, displayName: n, email: email.isEmpty ? nil : email))
                        guestName = ""
                        guestEmail = ""
                    }
                    .disabled(guestName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("Details") {
                    LabeledContent("Recorded", value: current.createdAt.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Duration", value: durationString(current.durationS))
                    LabeledContent("Size", value: sizeString(current.sizeBytes))
                    LabeledContent("Status", value: statusText(current.status))
                    if current.status == .failed, let error = current.uploadError {
                        LabeledContent("Error") { Text(error).foregroundStyle(.red) }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        library.delete(recording)
                        onDone()
                    } label: {
                        Label("Delete recording", systemImage: "trash")
                    }
                }
            }
            .navigationTitle("Recording")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { save(); onDone() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .fullScreenCover(isPresented: $playing) {
            PlayerLoader(recording: current, library: library)
        }
        // Persist the name if the sheet is swiped away.
        .onDisappear { save() }
    }

    private func save() {
        library.rename(recording, to: name)
        library.setParticipants(recording, players)
    }
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

func durationString(_ seconds: Double) -> String {
    let s = Int(seconds)
    return String(format: "%d:%02d", s / 60, s % 60)
}

func sizeString(_ bytes: Int) -> String {
    let mb = Double(bytes) / 1_000_000
    if mb >= 1000 { return String(format: "%.1f GB", mb / 1000) }
    return mb >= 1 ? String(format: "%.0f MB", mb) : "<1 MB"
}

func subtitle(_ r: Recording) -> String {
    "\(r.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(durationString(r.durationS)) · \(sizeString(r.sizeBytes))"
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
