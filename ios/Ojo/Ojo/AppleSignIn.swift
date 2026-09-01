import AuthenticationServices
import CryptoKit
import Foundation

/// Sign in with Apple, as Guideline 4.8 requires.
///
/// The guideline asks that an app offering a third-party login (Google, here)
/// also offer one that limits collection to name and email, lets the person keep
/// their email address private, and does no advertising tracking. Email and
/// password cannot satisfy the middle requirement — collecting the address *is*
/// the mechanism — so Sign in with Apple is the option that does.
///
/// The flow is native rather than a web redirect: Apple hands back a signed
/// identity token, which Supabase verifies itself via `signInWithIdToken`. No
/// browser hop, and nothing to allow-list in the Supabase URL configuration.
@MainActor
enum AppleSignIn {

    struct Result {
        /// The signed JWT from Apple. Supabase verifies this against Apple's keys.
        let idToken: String
        /// The un-hashed nonce. Apple embeds its SHA-256 in the token; Supabase
        /// re-hashes this and compares, which is what stops a token being replayed.
        let rawNonce: String
        /// Apple sends the name **only on the very first authorisation** for an
        /// Apple ID, and never again. Captured here so the profile can be seeded.
        let fullName: PersonNameComponents?
        /// Either the real address or a private relay one, depending on what the
        /// person chose. Both are addresses we can mail; neither is guaranteed to
        /// match an address they were invited by, which is precisely why invites
        /// are claimed by token rather than by address (see 0015_invites.sql).
        let email: String?
    }

    enum Failure: Error {
        case cancelled
        case noIdentityToken
        case underlying(Error)
    }

    /// Present the system sheet and return what Apple gives back.
    static func run() async throws -> Result {
        let rawNonce = randomNonce()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        // Apple hashes the nonce into the token; we keep the raw one to hand to
        // Supabase, which is how the token is bound to this specific request.
        request.nonce = sha256(rawNonce)

        let delegate = Delegate()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = delegate
        controller.presentationContextProvider = delegate

        let credential = try await withCheckedThrowingContinuation { continuation in
            delegate.continuation = continuation
            controller.performRequests()
        }
        // Held until the callback fires — ASAuthorizationController keeps only a
        // weak reference to its delegate, so without this it deallocates and
        // nothing is ever called back.
        _ = delegate

        guard let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8) else {
            throw Failure.noIdentityToken
        }

        return Result(
            idToken: idToken,
            rawNonce: rawNonce,
            fullName: credential.fullName,
            email: credential.email
        )
    }

    // MARK: - Nonce

    private static func randomNonce(length: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // Never observed in practice; falling back to a UUID pair keeps the
            // flow alive rather than trapping on the user's only way in.
            return UUID().uuidString + UUID().uuidString
        }
        // Base64url without padding: the nonce travels in a JWT claim.
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    // MARK: - Delegate

    private final class Delegate: NSObject, ASAuthorizationControllerDelegate,
                                  ASAuthorizationControllerPresentationContextProviding {
        var continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>?

        func authorizationController(controller: ASAuthorizationController,
                                     didCompleteWithAuthorization authorization: ASAuthorization) {
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                continuation?.resume(throwing: Failure.noIdentityToken)
                continuation = nil
                return
            }
            continuation?.resume(returning: credential)
            continuation = nil
        }

        func authorizationController(controller: ASAuthorizationController,
                                     didCompleteWithError error: Error) {
            // Dismissing the sheet is a normal thing to do, not an error worth
            // showing in red under the button.
            let failure: Failure = (error as? ASAuthorizationError)?.code == .canceled
                ? .cancelled
                : .underlying(error)
            continuation?.resume(throwing: failure)
            continuation = nil
        }

        func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
