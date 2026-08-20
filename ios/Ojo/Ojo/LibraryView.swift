import SwiftUI
import Supabase
import UIKit

/// The "You" tab — your profile and your matches on one screen.
///
/// Replaces the old separate Matches and Profile tabs. It keeps the profile
/// layout (avatar, name, follower counts) and puts the match grid underneath,
/// because the thing that makes this screen different from the web's library is
/// exactly what only this phone knows: recordings that haven't been uploaded yet.
struct LibraryView: View {
    @ObservedObject var auth: AuthModel
    @ObservedObject var library: RecordingLibrary

    /// Shared so coming back to this tab doesn't blank the header and re-fetch.
    @ObservedObject private var cache = AppCache.shared
    @State private var editing = false

    private var profile: ProfileSummary? { cache.profile }
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
        .refreshable {
            await library.refreshFromCloud(force: true)
            await cache.refreshProfile(force: true)
        }
        .task {
            await library.refreshFromCloud()
            await cache.refreshProfile()
        }
        .sheet(isPresented: $editing) {
            EditProfileView(onSaved: {
                editing = false
                cache.invalidateProfile()
                Task { await cache.refreshProfile() }
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
    @State private var setupOpen = false
    @State private var sharePayload: SharePayload?
    @State private var preparingShare = false

    private var status: MatchStatus? { library.status(for: recording) }
    private var actions: [MatchAction] { MatchAction.stack(for: recording) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Everything above the buttons is one tap target for the match.
            NavigationLink(value: WatchTarget.recording(recording)) {
                VStack(alignment: .leading, spacing: 8) {
                    RecordingThumbnail(
                        recording: recording,
                        localURL: library.fileURL(for: recording),
                        hasLocal: library.hasLocalFile(recording)
                    )
                    .aspectRatio(16.0 / 9.0, contentMode: .fill)
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 8))

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
                        ProgressBar(value: recording.progress)
                    } else if recording.status == .failed, let message = recording.uploadError {
                        Text(message)
                            .font(.caption2).foregroundStyle(Theme.danger)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            VStack(spacing: 6) {
                ForEach(actions, id: \.self) { actionButton($0) }
            }
        }
        .frame(maxWidth: .infinity)
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
        .sheet(item: $sharePayload) { payload in
            ShareSheet(url: payload.url)
        }
        .sheet(isPresented: $setupOpen) {
            MatchSetupSheet(
                purpose: .beforeUpload,
                existing: recording.participants ?? [],
                subject: MatchSubject(
                    title: recording.title,
                    createdAt: recording.createdAt,
                    durationS: recording.durationS,
                    sizeBytes: recording.sizeBytes
                ),
                shareURL: { await shareTarget() },
                onDelete: { library.delete(recording) },
                onSecondary: { setup in
                    rename(setup)
                    library.upload(recording, setup: setup)
                },
                onPrimary: { setup in
                    rename(setup)
                    library.upload(recording, setup: setup, analyse: true)
                }
            )
        }
    }

    private func rename(_ setup: MatchSetup) {
        guard let title = setup.title, title != recording.title else { return }
        library.rename(recording, to: title)
    }

    /// A link once it's in the cloud, the file itself before then.
    private func shareTarget() async -> URL? {
        if let videoId = recording.remoteVideoId,
           let link = try? await UploadAPI().createShareLink(videoId: videoId) {
            return URL(string: Config.apiBaseURL.absoluteString + link.path)
        }
        return library.hasLocalFile(recording) ? library.fileURL(for: recording) : nil
    }

    @ViewBuilder private func actionButton(_ action: MatchAction) -> some View {
        switch action {
        case .watch:
            NavigationLink(value: WatchTarget.recording(recording)) {
                actionLabel(action)
            }
            .buttonStyle(.plain)
        case .share:
            Button { presentShare() } label: {
                actionLabel(action)
            }
            .buttonStyle(.plain)
            .disabled(preparingShare)
        case .uploading:
            actionLabel(action).opacity(0.6)
        case .upload, .retryUpload, .aiBreakdown:
            // Both routes open the shelf; its own two buttons decide whether the
            // breakdown runs. Either way we want to know who played.
            Button { setupOpen = true } label: {
                actionLabel(action)
            }
            .buttonStyle(.plain)
        }
    }

    private func actionLabel(_ action: MatchAction,
                             titleOverride: String? = nil,
                             imageOverride: String? = nil) -> some View {
        let filled = action.isPrimary
        return Label(titleOverride ?? action.title, systemImage: imageOverride ?? action.systemImage)
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

    /// Hand the match to the system share sheet, the same as everywhere else.
    private func presentShare() {
        guard !preparingShare else { return }
        preparingShare = true
        Task {
            defer { preparingShare = false }
            if let url = await shareTarget() {
                sharePayload = SharePayload(url: url)
            }
        }
    }
}
