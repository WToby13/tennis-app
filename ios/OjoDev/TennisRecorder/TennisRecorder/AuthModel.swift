import Combine
import Foundation
import Supabase

/// Email + password and Google sign-in. Account creation collects the same
/// profile fields as the web app (name + playing hand) so the profile row is
/// populated by the `handle_new_user` trigger.
@MainActor
final class AuthModel: ObservableObject {
    @Published var isSignedIn = false
    @Published var email = ""
    @Published var password = ""
    // Profile fields, collected on sign-up (mirrors the web /sign-up form).
    @Published var firstName = ""
    @Published var lastName = ""
    @Published var handedness = "right" // "left" | "right"
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    /// The signed-in account's email (from the session), for the profile display.
    @Published var accountEmail: String?

    /// The OAuth redirect back into the app — must match the Info.plist URL scheme
    /// and be allow-listed in Supabase → Auth → URL Configuration.
    private let oauthRedirect = URL(string: "ojo://auth-callback")!

    init() {
        Task { await refresh() }
    }

    /// Restore any persisted session on launch (the SDK stores it in the keychain).
    func refresh() async {
        let session = try? await Supa.client.auth.session
        isSignedIn = session != nil
        accountEmail = session?.user.email
    }

    func signIn() async {
        busy = true; error = nil; notice = nil
        do {
            let session = try await Supa.client.auth.signIn(email: email, password: password)
            accountEmail = session.user.email
            isSignedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func signUp() async {
        busy = true; error = nil; notice = nil
        let displayName = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        do {
            let response = try await Supa.client.auth.signUp(
                email: email,
                password: password,
                // Read by the handle_new_user trigger to populate the profile row.
                data: [
                    "first_name": .string(firstName),
                    "last_name": .string(lastName),
                    "handedness": .string(handedness),
                    "display_name": .string(displayName),
                ]
            )
            // With email confirmation disabled a session comes back immediately.
            if response.session != nil {
                accountEmail = response.user.email
                isSignedIn = true
            } else {
                notice = "Account created. Confirm via email, then sign in."
            }
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    /// Google sign-in via Supabase's hosted OAuth in an ASWebAuthenticationSession.
    /// Uses the same Google provider as the web app; no separate Google iOS client
    /// is needed — the in-app browser returns to the app via `oauthRedirect`.
    func signInWithGoogle() async {
        busy = true; error = nil; notice = nil
        do {
            let session = try await Supa.client.auth.signInWithOAuth(
                provider: .google,
                redirectTo: oauthRedirect
            )
            accountEmail = session.user.email
            isSignedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    func signOut() async {
        try? await Supa.client.auth.signOut()
        accountEmail = nil
        isSignedIn = false
        // Cached feed/profile belong to the account that just left.
        AppCache.shared.clear()
    }
}
