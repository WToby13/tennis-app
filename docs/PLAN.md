# Ojo — MVP Plan

## Context
A hobby app to record tennis on an iPhone, upload the video (S3 multipart), and review it online.
For me + friends first. Recordings up to ~2 hours. Analysis for v1 is **playback only**: scrub,
frame-step, slow-mo/speed control. No tagging, stats, or AI yet.

Decisions:
- **Native record + web review** — a thin iOS app does only the reliability-critical work (long
  capture + resumable background upload); review is a web app.
- **iPhone only** for the MVP → pure Swift/SwiftUI recorder.
- **Storage/CDN: AWS S3 + CloudFront** (real S3 multipart, signed playback).
- **Analysis scope: review + scrub + speed only.**

## Architecture

```
iPhone (SwiftUI recorder)
  ├─ AVFoundation capture ──► local .mov (HEVC/H.264)
  └─ background URLSession ──► S3 multipart (presigned per-part)
                                     ▲ presign/init/complete
Web (Next.js) ── API routes ─────────┘   ├─ Supabase (Auth + Postgres metadata)
  └─ review player (scrub/frame-step/speed) └─ AWS: S3 (private) + CloudFront (signed)
                                                 └─ faststart remux (Lambda on upload)
```

## Core flow: S3 multipart upload
1. **Initiate** — `POST /api/uploads/initiate` → `CreateMultipartUpload` → `{ videoId, key, uploadId, partSize }`.
2. **Presign parts** — `POST /api/uploads/:id/part-url` per part → recorder PUTs the chunk **directly to storage**, captures `ETag`.
3. **Complete** — `POST /api/uploads/:id/complete` with ordered `{partNumber, ETag}` → `CompleteMultipartUpload`.
4. **Resume/abort** — persist `uploadId` + parts locally; on relaunch `list-parts` and upload only what's missing.

Sizing: 2h @ 1080p30 HEVC ≈ 4–8 GB. Part size ~8–128 MB. S3 min 5 MB/part, max 10,000 parts.

## Known gotcha (handled in prod): web scrubbing
iPhone MP4/MOV put the `moov` atom at the **end**, blocking seek until full download. Fix: S3-triggered
Lambda runs `ffmpeg -movflags +faststart` (remux, no re-encode); video flips `processing → ready`.

## Milestones
- **M0** Infra (S3, CloudFront, Supabase, scaffold) — *scaffold done, cloud pending*
- **M1** Backend multipart routes — *done (local adapter)*
- **M2** iOS recorder (capture + upload) — *source scaffolded*
- **M3** Web review (list + player) — *done*
- **M4** Upload hardening (background URLSession, resume, faststart, signed playback)
- **M5** Polish (invites, thumbnails, error states, lifecycle cleanup)

## Out of scope for v1
Tagging/clips, stats, AI (ball/player tracking), Android, HLS, live streaming.
