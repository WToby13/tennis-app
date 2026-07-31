import Foundation
import Supabase

/// Email + password sign-in (no emails sent, so no rate limits).
@MainActor
final class AuthModel: ObservableObject {
    @Published var isSignedIn = false
    @Published var email = ""
    @Published var password = ""
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?

    init() {
        Task { await refresh() }
    }

    /// Restore any persisted session on launch (the SDK stores it in the keychain).
    func refresh() async {
        let session = try? await Supa.client.auth.session
        isSignedIn = session != nil
    }

    func signIn() async {
        busy = true; error = nil; notice = nil
        do {
            try await Supa.client.auth.signIn(email: email, password: password)
            isSignedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func signUp() async {
        busy = true; error = nil; notice = nil
        do {
            let response = try await Supa.client.auth.signUp(email: email, password: password)
            // With email confirmation disabled a session comes back immediately.
            if response.session != nil {
                isSignedIn = true
            } else {
                notice = "Account created. Confirm via email, then sign in."
            }
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func signOut() async {
        try? await Supa.client.auth.signOut()
        isSignedIn = false
    }
}
