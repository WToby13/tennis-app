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
            Analytics.track(.signIn, props: ["method": "password"])
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
            // Counted either way: the account exists, and whether it needs an
            // email confirmation first is a Supabase setting, not something the
            // person did. Flushed at once so it isn't lost if they close the app
            // to go and find the confirmation mail.
            Analytics.track(.signupCompleted, props: [
                "method": "password",
                "confirmationPending": .bool(response.session == nil),
            ])
            Analytics.flush()
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
            // Google gives us no "is this new" flag, so it's judged the same way
            // the web callback judges it: from how old the account is.
            let isNew = Date().timeIntervalSince(session.user.createdAt) < 120
            Analytics.track(isNew ? .signupCompleted : .signIn, props: ["method": "google"])
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    /// Sign in with Apple — the Guideline 4.8 "equivalent login option".
    ///
    /// Native, not a web redirect: Apple returns a signed identity token and
    /// Supabase verifies it directly, so there is no browser hop and nothing to
    /// allow-list in the Supabase URL configuration.
    ///
    /// Apple sends the person's name **only on the first authorisation** for an
    /// Apple ID and never again, so it is written into the profile immediately.
    /// Miss it and there is no second chance short of the user revoking the app
    /// in iOS Settings.
    func signInWithApple() async {
        busy = true; error = nil; notice = nil
        do {
            let apple = try await AppleSignIn.run()
            let session = try await Supa.client.auth.signInWithIdToken(
                credentials: .init(provider: .apple, idToken: apple.idToken, nonce: apple.rawNonce)
            )
            accountEmail = session.user.email
            isSignedIn = true

            let isNew = Date().timeIntervalSince(session.user.createdAt) < 120
            if isNew { await seedProfile(from: apple, userId: session.user.id.uuidString.lowercased()) }
            Analytics.track(isNew ? .signupCompleted : .signIn, props: ["method": "apple"])
            if isNew { Analytics.flush() }
        } catch AppleSignIn.Failure.cancelled {
            // Backing out of the sheet is not a failure to report.
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }

    /// Put Apple's one-time name on the profile row.
    ///
    /// `handle_new_user` fills the row from sign-up metadata, which an Apple
    /// sign-in has none of — so without this the person is "Ojo player" forever,
    /// and their name is the thing other players see on a shared match.
    private func seedProfile(from apple: AppleSignIn.Result, userId: String) async {
        let first = apple.fullName?.givenName ?? ""
        let last = apple.fullName?.familyName ?? ""
        let display = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
        guard !display.isEmpty else { return }

        struct ProfileSeed: Encodable {
            let display_name: String
            let first_name: String
            let last_name: String
        }
        // Best effort: a name that fails to save is not worth blocking a
        // successful sign-in over, and the person can set it in Edit profile.
        do {
            try await Supa.client
                .from("profiles")
                .update(ProfileSeed(display_name: display, first_name: first, last_name: last))
                .eq("id", value: userId)
                .execute()
        } catch {
            print("[auth] could not seed profile from Apple name: \(error)")
        }
    }

    func signOut() async {
        try? await Supa.client.auth.signOut()
        accountEmail = nil
        isSignedIn = false
        // Cached feed/profile belong to the account that just left.
        AppCache.shared.clear()
        // As do any events still waiting to go out — sending them now would
        // attribute the last account's activity to whoever signs in next.
        Analytics.reset()
    }
}
