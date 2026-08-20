import Foundation
import Supabase

/// Shared Supabase client. Fill these in from your project's
/// Settings → API page (same values as the web app's NEXT_PUBLIC_SUPABASE_*).
enum Supa {
    static let url = URL(string: "https://vvhxjlfzdvmiuxkeegxi.supabase.co")!
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2aHhqbGZ6ZHZtaXV4a2VlZ3hpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTUwOTUsImV4cCI6MjEwMTA3MTA5NX0.IQ-ldA68tue2szm3D1glRXAT0C2zR7i605vHHCZDitc"

    static let client = SupabaseClient(supabaseURL: url, supabaseKey: anonKey)

    /// Current access token (JWT) for authorizing API calls, or nil if signed out.
    static func accessToken() async -> String? {
        try? await client.auth.session.accessToken
    }

    /// Current signed-in user's id (matches videos' `ownerId`), or nil if signed out.
    static func currentUserId() async -> String? {
        guard let session = try? await client.auth.session else { return nil }
        return session.user.id.uuidString.lowercased()
    }
}
