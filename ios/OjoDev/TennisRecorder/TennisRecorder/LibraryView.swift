import SwiftUI
import Supabase

/// The "You" tab — your profile and your matches on one screen.
///
/// Replaces the old separate Matches and Profile tabs. It keeps the profile
/// layout (avatar, name, follower counts) and puts the match grid underneath,
/// because the thing that makes this screen different from the web's library is
/// exactly what only this phone knows: recordings that haven't been uploaded yet.
struct LibraryView: View {
    @ObservedObject var auth: AuthModel
    @ObservedObject var library: RecordingLibrary

    @State private var profile: ProfileSummary?
    @State private var editing = false

    private let api = UploadAPI()
    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header
                actions
                if library.displayed.isEmpty {
                    emptyState
                } else {
                    grid
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 32)
        }
        .background(Theme.bg)
        .navigationTitle("You")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await library.refreshFromCloud() }
        .task {
            await library.refreshFromCloud()
            profile = try? await api.getMyProfile().profile
        }
        .sheet(isPresented: $editing) {
            EditProfileView(onSaved: {
                editing = false
                Task { profile = try? await api.getMyProfile().profile }
            })
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 10) {
            Avatar(name: profile?.displayName, size: 84)
            Text(profile?.displayName ?? "…")
                .font(.title3.bold()).foregroundStyle(Theme.text)
            if let p = profile {
                Text("\(p.followers) followers · \(p.following) following")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }
            if let email = auth.accountEmail {
                Text(email).font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button { editing = true } label: {
                Text("Edit profile").font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.accent, lineWidth: 1.5))
                    .foregroundStyle(Theme.accent)
            }
            Button(role: .destructive) {
                Task { await auth.signOut() }
            } label: {
                Text("Sign out").font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.border, lineWidth: 1.5))
                    .foregroundStyle(Theme.text)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Matches

    private var grid: some View {
        LazyVGrid(columns: columns, spacing: 14) {
            ForEach(library.displayed) { recording in
                LibraryCard(recording: recording, library: library)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "video.slash")
                .font(.system(size: 36))
                .foregroundStyle(Theme.muted)
            Text("No matches yet").font(.headline).foregroundStyle(Theme.text)
            Text("Tap Record to capture your first match.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 30)
    }
}

/// One match: poster, title, status chips and the single action that makes sense
/// for the state it's in (see `MatchAction`).
struct LibraryCard: View {
    let recording: Recording
    @ObservedObject var library: RecordingLibrary

    @State private var confirmingDelete = false

    private var status: MatchStatus? { library.status(for: recording) }
    private var action: MatchAction { MatchAction.of(recording) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink(value: WatchTarget.recording(recording)) {
                RecordingThumbnail(
                    recording: recording,
                    localURL: library.fileURL(for: recording),
                    hasLocal: library.hasLocalFile(recording)
                )
                .aspectRatio(16.0 / 9.0, contentMode: .fill)
                .frame(maxWidth: .infinity)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)

            Text(recording.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(1)

            Text(recording.createdAt.formatted(date: .abbreviated, time: .omitted))
                .font(.caption2).foregroundStyle(Theme.muted)

            // Chips: what's happening (if anything), then who can see it.
            HStack(spacing: 6) {
                if let chip = MatchChips.activity(recording, status) { StatusChip(chip: chip) }
                if let chip = MatchChips.share(recording, status) { StatusChip(chip: chip) }
            }

            if recording.status == .uploading {
                ProgressView(value: recording.progress).tint(Theme.accent)
            } else if recording.status == .failed, let message = recording.uploadError {
                Text(message).font(.caption2).foregroundStyle(Theme.danger).lineLimit(2)
            }

            actionButton
        }
        .padding(10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.border, lineWidth: 1))
        .contextMenu {
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label("Delete match", systemImage: "trash")
            }
        }
        .alert("Delete this match?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive) { library.delete(recording) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes it from this phone and from the cloud.")
        }
    }

    @ViewBuilder private var actionButton: some View {
        switch action {
        case .share:
            NavigationLink(value: WatchTarget.recording(recording)) {
                actionLabel(action, filled: false)
            }
            .buttonStyle(.plain)
        case .uploading:
            actionLabel(action, filled: false).opacity(0.6)
        case .uploadAndAnalyse, .retryUpload:
            Button {
                library.upload(recording, thenAnalyse: true)
            } label: {
                actionLabel(action, filled: true)
            }
            .buttonStyle(.plain)
        }
    }

    private func actionLabel(_ action: MatchAction, filled: Bool) -> some View {
        Label(action.title, systemImage: action.systemImage)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(filled ? Theme.accent : Color.clear,
                        in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .stroke(filled ? Color.clear : Theme.border, lineWidth: 1)
            )
            .foregroundStyle(filled ? Theme.text : Theme.muted)
    }
}
