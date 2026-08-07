# Ojo Tennis — Handover / New-Machine Setup

Everything you need to get this project running on a fresh Mac after cloning
from GitHub. Read §3 first — a couple of things are **not** in the repo.

Repo: `https://github.com/WToby13/tennis-app` (private, GitHub user `WToby13`).

---

## 1. What this is
A hobby tennis record/review app.
- **iOS** (`ios/`, SwiftUI): record a match → S3 multipart upload.
- **Web** (`web/`, Next.js App Router): review with scrub / frame-step / slow-mo,
  sharing + a social feed, and an **AI rally breakdown** (TwelveLabs Pegasus 1.5
  + a structural smoother) that maps the match into service games and rallies.
- **Storage**: AWS S3 + CloudFront (signed URLs). **Metadata/auth**: Supabase.
- **Deploy**: Vercel (web). **Email**: Resend.

---

## 2. Clone
```bash
git clone https://github.com/WToby13/tennis-app.git
cd tennis-app
```

---

## 3. In the repo vs NOT in the repo (read this)
**In the repo:** web app, iOS source (both projects), Supabase migrations,
Terraform (`infra/`), and all docs.

**NOT in the repo — you must bring these from the old machine or reconstruct them:**
1. **`web/.env`** — all runtime secrets (AWS, CloudFront key, Supabase keys,
   Resend, TwelveLabs). Gitignored. Also stored in the **Vercel project env**, so
   you can rebuild it from there (see §6).
2. **`infra/terraform.tfstate`** (+ `.backup`) — Terraform state for the **live**
   AWS infra. Not in git (it contains keys). If you want to keep managing the
   infra with Terraform, copy these files across **securely, out-of-band** (not
   GitHub). Without them the infra keeps running fine; you'd just have to
   `terraform import` to manage it again.

---

## 4. Prerequisites (install on the new Mac)
- **Git** + access to the private repo (GitHub user `WToby13`).
- **Node.js 20+** (developed on v24) and npm. `nvm` recommended.
- **Xcode 26.x** (iOS 26 SDK) from the App Store — for the iOS app. After install:
  `sudo xcodebuild -license accept`.
- An **Apple ID** (free 7-day provisioning) or a paid Apple Developer account, to
  run on a physical iPhone.
- **ffmpeg + ffprobe** on PATH (`brew install ffmpeg`) — for the thumbnail
  backfill script.
- *(Optional)* **Terraform** + **AWS CLI** if you'll manage the AWS infra.
- Log in to the accounts you already own: **Supabase**, **AWS** (account
  `637423278657`, region `eu-west-1`), **Vercel**, **TwelveLabs**, **Resend**.

---

## 5. Web app
```bash
cd web
npm install
cp .env.example .env      # then fill in real values — see §6
npm run dev               # http://localhost:3000
```
- Typecheck: `npx tsc --noEmit`  ·  Build: `npm run build`.
- **Local no-auth mode** (no cloud needed): run with the Supabase vars blank and
  `STORAGE_BACKEND=local` — the app falls back to on-disk storage + no login.

---

## 6. Environment variables (`web/.env`)
`web/.env.example` documents every var. Real values live in the **Vercel project
→ Settings → Environment Variables** — copy them from there (or from the old
machine's `web/.env` before you wipe it). Never commit `web/.env`.

- `STORAGE_BACKEND=s3`, `PART_SIZE_BYTES`
- `AWS_REGION=eu-west-1`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY`
  (raw or base64 PEM), `CLOUDFRONT_URL_TTL_SECONDS`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`, `EMAIL_FROM`, `NEXT_PUBLIC_APP_URL`
- `TWELVELABS_API_KEY` (+ optional `TWELVELABS_BASE_URL`)

---

## 7. Supabase (auth + metadata)
Migrations: `supabase/migrations/0001…0010` (0009 = AI analysis, 0010 = player
names).
- **Existing project** (already provisioned, all migrations applied): just point
  `.env` at it — nothing to run.
- **Fresh project**: run every migration **in order** in the SQL editor. Then
  disable "Confirm email" (Auth → Providers → Email). Google OAuth is optional —
  see `docs/GOOGLE_AUTH.md`.

---

## 8. AWS storage (`infra/`)
Terraform provisions a private S3 bucket + CloudFront (OAC, signed-URL-only) +
least-priv IAM. **It is already live** (account `637423278657`, `eu-west-1`). To
manage it with Terraform bring `infra/terraform.tfstate` (§3). Details in
`docs/DEPLOY.md`.

---

## 9. iOS app
Two Xcode projects under `ios/`:
- **`ios/OjoDev/TennisRecorder/`** — the **current** app (Ojo branding). Open
  `TennisRecorder.xcodeproj`.
- `ios/TennisRecorder/TennisRecorder/` — the older, superseded project.

Setup in Xcode 26:
1. Open the `.xcodeproj`; let SPM resolve **supabase-swift**.
2. Signing & Capabilities → select your **Team**.
3. Pick an iPhone; enable **Developer Mode** on the device; trust the cert.
4. Confirm `SupabaseConfig.swift` (Supabase URL + anon key) and `UploadAPI`'s
   `apiBaseURL` (the Vercel URL) are set.
5. `Info.plist` already has camera/mic usage strings, an ATS exception, and the
   `ojo://` URL scheme (Google OAuth redirect).

Recording is H.264, locked landscape, capped at 1080p. Uploads use a background
`URLSession` (multipart) and auto-free the local file once confirmed in the cloud.

---

## 10. Deploy (Vercel)
The repo is linked to Vercel with **root directory = `web`**; push to `main`
auto-deploys. Env vars are set in Vercel (§6). **Deployment Protection must stay
OFF** so the iOS app and shared links can reach `/api/*`. See `docs/DEPLOY.md`.

---

## 11. AI rally breakdown (where the pieces live)
- Prompt/params (Pegasus 1.5, `time_based_metadata`): `web/lib/twelvelabs/rally.ts`
- REST client: `web/lib/twelvelabs/client.ts`  ·  result parsing:
  `web/lib/twelvelabs/types.ts`
- Structural smoother (server alternation, game detection, shot floor):
  `web/lib/twelvelabs/smooth.ts`
- API route (start/poll, owner-only, size guard, warm-up trim):
  `web/app/api/videos/[id]/analyze/route.ts`
- UI (timeline, setup panel, player names): `web/app/RallySegments.tsx`
- Known limits & future work (compression proxy for >4GB files, `media_sources`
  reference stills for player identity): see the handover notes in
  `docs/` and the `twelvelabs-tennis-handover.md` you tested from.
- Thumbnails backfill: `npm run regenerate-thumbnails` (needs ffmpeg +
  `SUPABASE_SERVICE_ROLE_KEY`).

---

## 12. TL;DR
```bash
git clone https://github.com/WToby13/tennis-app.git
cd tennis-app/web
npm install
cp .env.example .env         # fill from Vercel env
npm run dev
```
For iOS: open `ios/OjoDev/TennisRecorder/TennisRecorder.xcodeproj` in Xcode 26,
set your signing team, run on device.

Other reference docs: `docs/DEPLOY.md`, `docs/SHARING.md`, `docs/EMAIL.md`,
`docs/GOOGLE_AUTH.md`, `docs/PLAN.md`.
