import SwiftUI

/// App root: owns the shared auth + library models and gates the whole app on
/// sign-in. Signed in → the main tab bar; signed out → the login screen.
struct RootView: View {
    @StateObject private var auth = AuthModel()
    @StateObject private var library = RecordingLibrary()

    var body: some View {
        Group {
            if auth.isSignedIn {
                MainTabView(auth: auth, library: library)
            } else {
                LoginView(auth: auth)
            }
        }
        .tint(Theme.accent)
        .preferredColorScheme(.dark)
        // Drop the previous account's matches the moment the session ends.
        //
        // `library` is a @StateObject here, so it outlives the signed-in screen
        // and would otherwise hand the next account the last one's cloud list.
        // Keyed on `isSignedIn` rather than called from `signOut()` so an expired
        // or revoked session clears it too, not only an explicit sign-out.
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { library.clearForSignOut() }
        }
    }
}
