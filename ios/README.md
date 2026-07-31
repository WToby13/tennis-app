# Tennis Recorder — iOS

A SwiftUI app that records a match with AVFoundation, signs in with Supabase, and
uploads with resumable S3 multipart against the same API the web app uses.

These are source files, not a checked-in Xcode project. Follow the setup below once
(≈10 min after Xcode is installed).

## Files

| File | Role |
|------|------|
| `TennisRecorderApp.swift` | App entry point |
| `ContentView.swift` | Auth gate → `LoginView` or `RecorderView` (+ camera preview) |
| `LoginView.swift` | Email → 6-digit code sign-in |
| `AuthModel.swift` | Supabase email-OTP auth state |
| `SupabaseConfig.swift` | Supabase client + your project URL/key |
| `CameraRecorder.swift` | AVFoundation capture to a local `.mov` |
| `MultipartUploader.swift` | Chunks the file, uploads each part, completes |
| `UploadAPI.swift` | API client; attaches the Supabase JWT as a Bearer token |

## Setup (do this after Xcode has installed)

1. **New project.** Xcode → **File → New → Project → iOS → App**.
   - Product Name: `TennisRecorder`
   - Interface: **SwiftUI**, Language: **Swift**
   - Team: pick your **personal team** (your free Apple ID — add it in Xcode →
     Settings → Accounts if it's not there)
   - Bundle Identifier: something unique, e.g. `com.tobykeating.tennisrecorder`

2. **Swap in these files.** Delete the auto-generated `ContentView.swift` and
   `TennisRecorderApp.swift`, then drag every `.swift` file from
   `ios/TennisRecorder/` into the project navigator — tick **Copy items if needed**
   and make sure the app target is checked.

3. **Add the Supabase package.** **File → Add Package Dependencies…**, paste
   `https://github.com/supabase/supabase-swift`, **Add Package**, and add the
   **`Supabase`** library product to the `TennisRecorder` target.

4. **Add usage descriptions.** Target → **Info** tab → add two rows:
   - `Privacy - Camera Usage Description` → "Record your tennis matches."
   - `Privacy - Microphone Usage Description` → "Record match audio."

5. **(Local dev only) allow HTTP to your Mac.** If `apiBaseURL` points at
   `http://<your-Mac-LAN-IP>:3000`, iOS App Transport Security blocks cleartext.
   In the **Info** tab add `App Transport Security Settings → Allow Arbitrary Loads = YES`.
   Remove this once you point at your `https://…vercel.app` URL.

6. **Fill in your config:**
   - `SupabaseConfig.swift` → `Supa.url` and `Supa.anonKey` (same values as the web
     app's `NEXT_PUBLIC_SUPABASE_*`).
   - `UploadAPI.swift` → `Config.apiBaseURL`. For local testing use your Mac's LAN IP
     (`System Settings → Wi-Fi → Details → IP address`), e.g. `http://192.168.1.23:3000`,
     with the web dev server running. Later, your deployed `https://…vercel.app`.
   - Make sure that address is in your Supabase **Redirect URLs** and in the S3 bucket's
     `allowed_origins` (Terraform var) if the browser will hit it too.

7. **Run on your iPhone.** Plug it in, pick it as the run destination, press ▶.
   First run: on the phone, **Settings → General → VPN & Device Management** → trust your
   developer certificate. With a free Apple ID the app runs for **7 days**, then just
   re-run from Xcode to refresh it.

## Notes / still TODO

- **Email code:** make sure the Supabase Magic Link email template includes `{{ .Token }}`
  (see `supabase/README.md`) so the 6-digit code arrives.
- **Verify the auth API names** the first time you build — `signInWithOTP` / `verifyOTP`
  match supabase-swift v2; if you pull a different major version the signatures may differ.
- **Background uploads:** `MultipartUploader` uploads parts in-process. For true
  background/resumable transfers on a 2-hour file, move to a `URLSession(configuration:
  .background(...))` with `uploadTask(fromFile:)` — hook points marked `TODO(background)`.
