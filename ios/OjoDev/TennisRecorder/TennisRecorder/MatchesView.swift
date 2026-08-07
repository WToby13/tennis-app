import SwiftUI

/// The Matches tab — your library of recorded + uploaded matches. Local
/// not-yet-uploaded recordings and cloud matches, newest first. Tap a match to
/// open its Watch screen (review + manage); swipe to upload/retry or delete.
struct MatchesView: View {
    @ObservedObject var library: RecordingLibrary

    var body: some View {
        Group {
            if library.displayed.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(library.displayed) { recording in
                        NavigationLink(value: WatchTarget.recording(recording)) {
                            MatchRow(recording: recording, library: library)
                        }
                        .listRowBackground(Theme.surface)
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if recording.status == .pending || recording.status == .failed {
                                Button {
                                    library.upload(recording)
                                } label: {
                                    Label(recording.status == .failed ? "Retry" : "Upload",
                                          systemImage: "arrow.up.circle.fill")
                                }
                                .tint(.orange)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                library.delete(recording)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bg)
        .navigationTitle("Matches")
        .refreshable { await library.refreshFromCloud() }
        .task { await library.refreshFromCloud() }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "video.slash")
                .font(.system(size: 40))
                .foregroundStyle(Theme.muted)
            Text("No matches yet").font(.headline).foregroundStyle(Theme.text)
            Text("Tap Record to capture your first match.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}

/// A single match row: poster thumbnail, title + meta, status. Upload progress /
/// failure detail shows inline. (Tapping is handled by the enclosing
/// NavigationLink; swipe actions live there too.)
struct MatchRow: View {
    let recording: Recording
    @ObservedObject var library: RecordingLibrary

    var body: some View {
        HStack(spacing: 12) {
            RecordingThumbnail(
                recording: recording,
                localURL: library.fileURL(for: recording),
                hasLocal: library.hasLocalFile(recording)
            )
            .frame(width: 96, height: 54) // 16:9
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 3) {
                Text(recording.title).font(.headline).lineLimit(1).foregroundStyle(Theme.text)
                Text(subtitle(recording)).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)

                if recording.status == .uploading {
                    ProgressView(value: recording.progress).padding(.top, 2)
                } else if recording.status == .failed, let message = recording.uploadError {
                    Text(message).font(.caption2).foregroundStyle(Theme.danger).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            StatusBadge(status: recording.status)
        }
        .padding(.vertical, 6)
    }
}
