import SwiftUI
import Supabase

/// A profile navigation value — a specific user's public profile. (Destinations
/// are wired into the nav stacks alongside `WatchTarget`.)
enum ProfileTarget: Hashable, Identifiable {
    case user(id: String)

    /// So a tapped @tag in a comment can drive `navigationDestination(item:)`.
    var id: String {
        switch self {
        case .user(let id): return id
        }
    }
}

/// A player's profile — your own (the You tab: editable, with sign out) or
/// someone else's (pushed from an author link / people search: with a follow
/// button). Both show avatar, display name, follower/following counts and a grid
/// of their matches. Mirrors the web `/profile` and `/u/[id]`.
struct ProfileView: View {
    /// Present for the You tab (enables edit + sign out).
    var auth: AuthModel? = nil
    /// Present when viewing another user's profile.
    var userId: String? = nil

    @State private var profile: ProfileSummary?
    @State private var videos: [ProfileVideo] = []
    @State private var isSelf = false
    @State private var loading = true
    @State private var editing = false
    @State private var blocked = false

    private let api = UploadAPI()
    private var isOwnTab: Bool { userId == nil }

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header
                actions
                if !videos.isEmpty {
                    matchesGrid
                } else if !loading {
                    Text("No matches yet.").font(.footnote).foregroundStyle(Theme.muted)
                        .padding(.top, 8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 32)
        }
        .background(Theme.bg)
        .navigationTitle(isOwnTab ? "You" : (profile?.displayName ?? "Profile"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .toolbar {
            // Someone else's profile: report them, or block them outright.
            // Settings (account deletion, blocked accounts, the legal documents)
            // is NOT here: this screen is only ever pushed for another player.
            // The You tab is LibraryView, and that is where the gear lives.
            if !isOwnTab, let p = profile {
                ToolbarItem(placement: .topBarTrailing) {
                    ProfileBlockMenu(
                        userId: p.id,
                        displayName: p.displayName,
                        isBlocked: blocked,
                        onChange: { blocked = $0 }
                    )
                }
            }
        }
        .sheet(isPresented: $editing) {
            EditProfileView(onSaved: {
                editing = false
                Task { await load() }
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
            if isOwnTab, let email = auth?.accountEmail {
                Text(email).font(.caption).foregroundStyle(Theme.muted)
            }
        }
    }

    // MARK: Actions

    @ViewBuilder private var actions: some View {
        if isSelf {
            HStack(spacing: 12) {
                if auth != nil {
                    Button { editing = true } label: {
                        Text("Edit profile").font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.accent, lineWidth: 1.5))
                            .foregroundStyle(Theme.accent)
                    }
                    Button(role: .destructive) {
                        Task { await auth?.signOut() }
                    } label: {
                        Text("Sign out").font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.border, lineWidth: 1.5))
                            .foregroundStyle(Theme.text)
                    }
                }
            }
            .buttonStyle(.plain)
        } else if let p = profile {
            FollowButton(userId: p.id, initiallyFollowing: p.isFollowing)
        }
    }

    // MARK: Matches grid

    private var matchesGrid: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(videos) { video in
                NavigationLink(value: WatchTarget.video(id: video.id)) {
                    VStack(alignment: .leading, spacing: 6) {
                        RemoteThumbnail(urlString: video.thumbnailUrl)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        Text(video.title).font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        Text(parseISODate(video.createdAt).formatted(date: .abbreviated, time: .omitted))
                            .font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Load

    private func load() async {
        loading = true
        defer { loading = false }
        let id: String?
        if let userId { id = userId } else { id = await Supa.currentUserId() }
        guard let id else { return }
        if let resp = try? await api.getUserProfile(userId: id) {
            profile = resp.profile
            videos = resp.videos
            isSelf = resp.isSelf
            blocked = resp.profile.isBlocked ?? false
        }
    }
}

// MARK: - Block / report someone else's profile

/// The overflow menu on another player's profile. Separate from `ModerationMenu`
/// because a profile has no single piece of content to report — the action here
/// is about the person, and it has to be reversible from the same control.
private struct ProfileBlockMenu: View {
    let userId: String
    let displayName: String
    let isBlocked: Bool
    let onChange: (Bool) -> Void

    @State private var confirming = false
    private let api = UploadAPI()

    var body: some View {
        Menu {
            if isBlocked {
                Button { set(false) } label: {
                    Label("Unblock \(displayName)", systemImage: "hand.raised.slash")
                }
            } else {
                Button(role: .destructive) { confirming = true } label: {
                    Label("Block \(displayName)", systemImage: "hand.raised")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More options")
        .confirmationDialog("Block \(displayName)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Block", role: .destructive) { set(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You won't see their matches or comments, and they won't see yours. They aren't told.")
        }
    }

    private func set(_ blocked: Bool) {
        onChange(blocked)
        Task {
            // Snap back if the server disagrees, so the control never lies about state.
            if let now = try? await api.setBlocked(userId: userId, blocked: blocked) {
                onChange(now)
            } else {
                onChange(!blocked)
            }
        }
    }
}

// MARK: - Edit profile

/// Editable profile fields, written straight to the Supabase `profiles` row —
/// the same approach as the web `/profile` page.
struct EditProfileView: View {
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var handedness = "right"
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    private struct ProfileRow: Decodable {
        let display_name: String?
        let first_name: String?
        let last_name: String?
        let handedness: String?
    }
    private struct ProfileUpdate: Encodable {
        let display_name: String
        let first_name: String
        let last_name: String
        let handedness: String
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name shown to others") {
                    TextField("Display name", text: $displayName)
                }
                Section("Details") {
                    TextField("First name", text: $firstName)
                    TextField("Last name", text: $lastName)
                    Picker("Playing hand", selection: $handedness) {
                        Text("Left").tag("left")
                        Text("Right").tag("right")
                    }
                    .pickerStyle(.segmented)
                }
                if let error {
                    Text(error).foregroundStyle(Theme.danger).font(.footnote)
                }
            }
            .navigationTitle("Edit profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }.disabled(saving)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard let id = await Supa.currentUserId() else { return }
        do {
            let row: ProfileRow = try await Supa.client
                .from("profiles")
                .select("display_name,first_name,last_name,handedness")
                .eq("id", value: id)
                .single()
                .execute()
                .value
            displayName = row.display_name ?? ""
            firstName = row.first_name ?? ""
            lastName = row.last_name ?? ""
            handedness = row.handedness ?? "right"
        } catch {
            self.error = "Couldn't load your profile."
        }
    }

    private func save() {
        saving = true
        Task {
            defer { saving = false }
            guard let id = await Supa.currentUserId() else { return }
            let update = ProfileUpdate(
                display_name: displayName.trimmingCharacters(in: .whitespaces),
                first_name: firstName.trimmingCharacters(in: .whitespaces),
                last_name: lastName.trimmingCharacters(in: .whitespaces),
                handedness: handedness
            )
            do {
                try await Supa.client.from("profiles").update(update).eq("id", value: id).execute()
                onSaved()
            } catch {
                self.error = "Couldn't save. Try again."
            }
        }
    }
}
