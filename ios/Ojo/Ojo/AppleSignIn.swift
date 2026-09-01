import AuthenticationServices
import CryptoKit
import Foundation

/// Nonce handling for Sign in with Apple, as Guideline 4.8 requires.
///
/// The guideline asks that an app offering a third-party login (Google, here)
/// also offer one that limits collection to name and email, lets the person keep
/// their email address private, and does no advertising tracking. Email and
/// password cannot satisfy the middle requirement — collecting the address *is*
/// the mechanism — so Sign in with Apple is the option that does.
///
/// The button itself is SwiftUI's `SignInWithAppleButton`, which owns the
/// request and the callback. All that is left here is the nonce, which has to
/// survive between the two: Apple hashes it into the identity token, and
/// Supabase re-hashes the raw value to compare. That comparison is what stops a
/// token being replayed, so the raw value must be the one that produced the hash
/// Apple was given.
@MainActor
enum AppleSignIn {

    /// The raw nonce for the request currently in flight.
    ///
    /// Single-valued because the button cannot start a second authorisation
    /// while one is on screen. Cleared once consumed, so a stale nonce can never
    /// be paired with a later token.
    private static var pendingRawNonce: String?

    /// Make a nonce, stash the raw value, and return the SHA-256 for the request.
    static func beginRequestNonce() -> String {
        let raw = randomNonce()
        pendingRawNonce = raw
        return sha256(raw)
    }

    /// The raw nonce for the completed request, consumed on read.
    static func takeRawNonce() -> String? {
        defer { pendingRawNonce = nil }
        return pendingRawNonce
    }

    // MARK: - Nonce generation

    private static func randomNonce(length: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // Never observed in practice; falling back keeps the flow alive
            // rather than trapping on someone's only way into the app.
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
}
