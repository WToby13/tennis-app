# Ojo — Tennis Recorder & Review

Record tennis on an iPhone, upload with **S3 multipart**, and review it online (scrub, frame-step, slow-mo).
Hobby MVP for me + friends. See the full design in [`docs/PLAN.md`](docs/PLAN.md).

## Layout

```
tennis-app/
├── web/    Next.js review app + multipart API (runs locally today; S3/Supabase are config)
└── ios/    SwiftUI recorder (AVFoundation capture + background URLSession multipart) — `ios/Ojo/Ojo.xcodeproj`
```

## Quick start (web)

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000 — upload a video on `/upload` and watch it back on `/watch/:id`.

By default the app runs **fully local** (`STORAGE_BACKEND=local`): "multipart" parts are written to
`web/.data` through the same interface S3 uses, so you can exercise the entire
initiate → presigned-part-PUT → complete → playback loop with no cloud account.

### Going to production

Set the env vars in `web/.env.example` and flip `STORAGE_BACKEND=s3`. The storage adapter
(`web/lib/storage/`) already has the S3 implementation; you supply the bucket, CloudFront domain,
and credentials. Metadata moves from the local JSON store to Supabase (`web/lib/metadata/`).

## Status

- [x] Web: local storage adapter + multipart API + review player
- [x] Web: S3 + signed CloudFront wiring + Terraform infra (live)
- [x] Web: Supabase magic-link auth + Postgres metadata — set `NEXT_PUBLIC_SUPABASE_*` to enable (see [`supabase/README.md`](supabase/README.md))
- [x] iOS: full SwiftUI source (record + Supabase auth + multipart upload) — build in Xcode per [`ios/README.md`](ios/README.md)
- [x] iOS: App Store prep — renamed to Ojo, moderation + account deletion, legal pages ([`docs/APPSTORE.md`](docs/APPSTORE.md))
- [ ] iOS: TestFlight (needs paid Apple Developer account)
- [ ] Infra: faststart Lambda (iPhone moov-atom remux → smooth scrubbing)
- [x] iOS: background `URLSession`, per-part retry, and resume-from-S3 for long uploads
