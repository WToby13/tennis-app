# Ojo — iOS

The SwiftUI app: records a match with AVFoundation, signs in with Supabase, and
uploads with a resumable background `URLSession` against the same API the web
app uses.

Open **`ios/Ojo/Ojo.xcodeproj`** in Xcode 26. There is one project; the older
`ios/TennisRecorder/` was removed on 2026-08-18 (recoverable from git history).

## Identity

| | |
|---|---|
| App Store name | **Ojo Tennis** |
| Home-screen name | **Ojo** (`INFOPLIST_KEY_CFBundleDisplayName`) |
| Bundle id | `com.ojotennis.app` — **permanent once published** |
| Minimum iOS | 17.0 |
| Devices | iPhone only (`TARGETED_DEVICE_FAMILY = 1`) |
| Team | `2HZJ6DQYLM` |

Publishing walkthrough, including enrolling in the Apple Developer Program:
[`../docs/APPSTORE.md`](../docs/APPSTORE.md).

## Setup

1. Open the `.xcodeproj`; let SPM resolve **supabase-swift**.
2. **Signing & Capabilities** → pick your Team. Automatic signing.
3. Pick an iPhone, enable **Developer Mode** on it, trust the certificate.
4. Confirm `SupabaseConfig.swift` (project URL + anon key) and `UploadAPI`'s
   `Config.apiBaseURL` (the production URL) are right.
5. `Info.plist` already carries the camera/mic usage strings, the
   `ITSAppUsesNonExemptEncryption=false` export declaration, and the `ojo://`
   URL scheme used by the Google OAuth redirect.

## Files worth knowing

| File | Role |
|------|------|
| `OjoApp.swift` | Entry point; resumes background uploads on relaunch |
| `RootView.swift` | Auth gate → `MainTabView` or `LoginView` |
| `AuthModel.swift` | Supabase email/password + Google auth state |
| `CameraRecorder.swift` | AVFoundation capture, H.264, locked landscape, 1080p cap |
| `BackgroundUploader.swift` | Windowed multipart upload on a background `URLSession` |
| `UploadAPI.swift` | API client; attaches the Supabase JWT as a Bearer token |
| `WatchView.swift` | Review player: scrub, frame-step, slow-mo, rally timeline |
| `Moderation.swift` | Report / block UI + the blocked-accounts list |
| `SettingsView.swift` | Legal links, blocked accounts, sign out, **delete account** |

Recording is H.264, locked landscape, capped at 1080p. Uploads run on a
background `URLSession` and free the local file once the cloud confirms it.

## Still TODO

- **Large-file device test.** The Simulator can't meaningfully exercise a
  background `URLSession` across suspension and relaunch, which is exactly what
  the windowed uploader changed. Test with a real multi-GB match.
