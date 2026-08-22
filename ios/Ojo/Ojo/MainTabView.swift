import SwiftUI
import UIKit

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
    /// Whether the software keyboard is up.
    ///
    /// The bar rides up with the keyboard and would otherwise sit in the strip
    /// directly above it, squeezing the field someone is typing into. Standing it
    /// down while they type is what a tab bar is expected to do anyway.
    @State private var keyboardUp = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            // A plain VStack, not `safeAreaInset`.
            //
            // The bar used to be a bottom `safeAreaInset` on the NavigationStack,
            // which asks SwiftUI to shrink the safe area of everything inside —
            // including screens pushed onto the stack. On the Watch screen that
            // did not hold: the comment composer, being the last thing on a very
            // long page, stayed underneath the bar with no way to scroll it out,
            // so the tap meant for the text field hit the tab bar instead.
            //
            // Stacking them just takes the height away from the NavigationStack
            // instead of negotiating for it, so nothing inside can be laid out
            // under the bar in the first place. The bar is opaque, so nothing is
            // lost by content no longer scrolling beneath it.
            VStack(spacing: 0) {
                selectedTab
                if !chrome.tabBarHidden && !keyboardUp {
                    OjoTabBar(tab: $tab, onRecord: { showCamera = true })
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
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
            .navigationDestination(for: InboxTarget.self) { _ in
                NotificationsView()
            }
            // A match reached from a notification is the same screen, opened at
            // the conversation the notification was about.
            .navigationDestination(for: CommentTarget.self) { target in
                WatchView(target: .video(id: target.videoId), library: library,
                          startAtComments: true)
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
        // The bar sits above the home indicator, but its background has to carry
        // on past it — otherwise the page scrolls through a strip of its own
        // colour below the bar, which reads as the bar floating over the content.
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
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
