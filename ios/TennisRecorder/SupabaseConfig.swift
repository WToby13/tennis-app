import Foundation
import Supabase

/// Shared Supabase client. Fill these in from your project's
/// Settings → API page (same values as the web app's NEXT_PUBLIC_SUPABASE_*).
enum Supa {
    static let url = URL(string: "https://YOUR-PROJECT.supabase.co")!
    static let anonKey = "YOUR-SUPABASE-ANON-KEY"

    static let client = SupabaseClient(supabaseURL: url, supabaseKey: anonKey)

    /// Current access token (JWT) for authorizing API calls, or nil if signed out.
    static func accessToken() async -> String? {
        try? await client.auth.session.accessToken
    }
}
