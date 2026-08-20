import SwiftUI

/// The four primary destinations. Record is not a "tab" you stay on — it's a
/// prominent center button that launches the fullscreen camera as a modal, so
/// recording is always one tap away while the app itself opens to the feed.
/// Matches and Profile are one destination now ("You" — see LibraryView), so the
/// bar is Home, Record, You.
enum MainTab { case home, library }

/// The app's home once signed in: a record-forward custom tab bar over the
/// currently selected destination. Each destination is its own NavigationStack
/// so author names and match cards can push detail screens.
struct MainTabView: View {
    @ObservedObject var auth: AuthModel
    @ObservedObject var library: RecordingLibrary

    @State private var tab: MainTab = .home
    @State private var showCamera = false
    @State private var libraryPath = NavigationPath()
    /// Set by fullscreen surfaces (the immersive Watch screen) that want the
    /// whole screen — see `ChromeState`.
    @ObservedObject private var chrome = ChromeState.shared

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            selectedTab
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if !chrome.tabBarHidden {
                        OjoTabBar(tab: $tab, onRecord: { showCamera = true })
                    }
                }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraScreen(library: library) { recording in
                // Stop → jump straight to the new match's Watch screen to review,
                // name and share it.
                showCamera = false
                tab = .library
                libraryPath.append(WatchTarget.recording(recording))
            }
        }
    }

    @ViewBuilder private var selectedTab: some View {
        switch tab {
        case .home:
            NavigationStack {
                FeedView().ojoDestinations(library: library)
            }
        case .library:
            NavigationStack(path: $libraryPath) {
                LibraryView(auth: auth, library: library).ojoDestinations(library: library)
            }
        }
    }
}

extension View {
    /// The shared push destinations every tab's NavigationStack needs: a match's
    /// Watch screen, a user's public profile, and people search.
    func ojoDestinations(library: RecordingLibrary) -> some View {
        self
            .navigationDestination(for: WatchTarget.self) { target in
                WatchView(target: target, library: library)
            }
            .navigationDestination(for: ProfileTarget.self) { target in
                switch target {
                case .user(let id): ProfileView(userId: id)
                }
            }
            .navigationDestination(for: SearchTarget.self) { _ in
                PeopleSearchView()
            }
    }
}

// MARK: - Tab bar

struct OjoTabBar: View {
    @Binding var tab: MainTab
    var onRecord: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            TabBarButton(icon: "house.fill", label: "Home", isActive: tab == .home) { tab = .home }
            RecordTabButton(action: onRecord)
            TabBarButton(icon: "person.fill", label: "You", isActive: tab == .library) { tab = .library }
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
        }
    }
}

private struct TabBarButton: View {
    let icon: String
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 20, weight: .semibold))
                Text(label).font(.caption2.weight(.medium))
            }
            .foregroundStyle(isActive ? Theme.accent : Theme.muted)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The emphasized center Record button — a filled clay circle that reads as the
/// primary action in the bar.
private struct RecordTabButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                ZStack {
                    Circle().fill(Theme.accent).frame(width: 46, height: 46)
                    Circle().stroke(Theme.text.opacity(0.9), lineWidth: 2.5).frame(width: 24, height: 24)
                }
                Text("Record").font(.caption2.weight(.semibold)).foregroundStyle(Theme.text)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Record a match")
    }
}
