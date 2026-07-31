import Foundation
import Supabase

/// Email one-time-code sign-in (the mobile-friendly half of Supabase magic link).
/// The user enters their email, Supabase emails a 6-digit code, they type it back.
@MainActor
final class AuthModel: ObservableObject {
    @Published var isSignedIn = false
    @Published var email = ""
    @Published var codeSent = false
    @Published var busy = false
    @Published var error: String?

    init() {
        Task { await refresh() }
    }

    /// Restore any persisted session on launch (the SDK stores it in the keychain).
    func refresh() async {
        let session = try? await Supa.client.auth.session
        isSignedIn = session != nil
    }

    func sendCode() async {
        busy = true; error = nil
        do {
            try await Supa.client.auth.signInWithOTP(email: email)
            codeSent = true
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func verify(code: String) async {
        busy = true; error = nil
        do {
            try await Supa.client.auth.verifyOTP(email: email, token: code, type: .email)
            isSignedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func signOut() async {
        try? await Supa.client.auth.signOut()
        isSignedIn = false
        codeSent = false
    }
}
