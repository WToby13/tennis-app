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
    }
}
