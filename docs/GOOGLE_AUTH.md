# Google auth — setup runbook

Status: **code complete (web + iOS), 2026-08-04.** The buttons and flows are built;
Google itself won't work until the dashboard/console config below is done. Email+password
is unaffected and keeps working throughout.

Web and iOS use the **same** Supabase Google provider — there is **one** Google Cloud OAuth
client (a *Web application*), and iOS reaches it through Supabase's hosted flow in an in-app
browser. No separate Google iOS client is needed.

## 1. Google Cloud (once)
1. console.cloud.google.com → APIs & Services → **OAuth consent screen** → External → fill app
   name, support email, developer email. Add scopes `email`, `profile`, `openid`.
2. → **Credentials** → Create credentials → **OAuth client ID** → *Web application*.
3. Authorized redirect URI (exactly):
   `https://vvhxjlfzdvmiuxkeegxi.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client secret**.

## 2. Supabase (once)
1. Dashboard → **Authentication → Providers → Google** → enable, paste Client ID + secret, save.
2. **Authentication → URL Configuration → Redirect URLs** — add:
   - `https://ojotennis.com/auth/callback` and the Vercel prod URL's `/auth/callback`
   - `http://localhost:3000/auth/callback` (dev)
   - `ojo://auth-callback` (the iOS app)

## 3. iOS (once, in Xcode — needs Toby)
- The `ojo` URL scheme is already in `Info.plist` (`CFBundleURLTypes`). Rebuild so it's picked up.
- Nothing else: `signInWithOAuth(provider: .google, redirectTo: ojo://auth-callback)` presents an
  `ASWebAuthenticationSession` and returns the session. If SPM ever pins a supabase-swift where
  that convenience differs, adjust the call in `AuthModel.signInWithGoogle()`.

## 4. Migrations
Run in the SQL editor (after 0003):
- `0004_oauth_profile.sql` — makes `handle_new_user` populate first/last/display_name from Google
  metadata (`given_name`/`family_name`/`name`/`full_name`).

## How it behaves
- **Web:** "Continue with Google" on `/sign-in` and `/sign-up` → Google → `/auth/callback`. Since
  Google can't provide a *playing hand*, a first-time OAuth user is routed to **`/profile`** to
  set it; returning users go to their `?next=` (or the feed).
- **iOS:** "Continue with Google" on the login screen → in-app browser → back to the app signed in.
- **Account creation parity:** both web `/sign-up` and the iOS sign-up form collect first name,
  last name and handedness and pass them as sign-up metadata, so the profile row is created with
  those fields by the trigger.

## Not in this slice
Participants ("who played") is the remaining Slice 2 item — deferred; see `SHARING.md` §7/§9.
