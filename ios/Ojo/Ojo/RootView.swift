import SwiftUI

/// App root: owns the shared auth + library models and gates the whole app on
/// sign-in. Signed in → the main tab bar; signed out → the login screen. Both sit
/// under the launch splash until it has played and the session check is done.
struct RootView: View {
    @StateObject private var auth = AuthModel()
    @StateObject private var library = RecordingLibrary()
    @State private var splashDone = false

    var body: some View {
        ZStack {
            Group {
                if auth.isSignedIn {
                    MainTabView(auth: auth, library: library)
                } else {
                    LoginView(auth: auth)
                }
            }
            // Built underneath while the splash plays, so the feed is already
            // loading by the time it's revealed.
            .opacity(splashDone ? 1 : 0)

            if !splashDone {
                SplashView()
                    .transition(.opacity.combined(with: .scale(scale: 1.04)))
                    .zIndex(1)
            }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
        .background(Theme.bg.ignoresSafeArea())
        .task {
            try? await Task.sleep(for: .seconds(SplashView.duration))
            // The keychain read is instant; the token refresh behind it can need
            // the network. Never hold the splash more than a few seconds for it —
            // the stored session already says which screen to show.
            for _ in 0..<30 where !auth.restored {
                try? await Task.sleep(for: .milliseconds(100))
            }
            withAnimation(.easeOut(duration: 0.4)) { splashDone = true }
        }
        // Drop the previous account's matches the moment the session ends.
        //
        // `library` is a @StateObject here, so it outlives the signed-in screen
        // and would otherwise hand the next account the last one's cloud list.
        // Keyed on `isSignedIn` rather than called from `signOut()` so an expired
        // or revoked session clears it too, not only an explicit sign-out.
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { library.clearForSignOut() }
            Task { library.accountId = signedIn ? await Supa.currentUserId() : nil }
        }
        .task { library.accountId = await Supa.currentUserId() }
    }
}
