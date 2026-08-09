# Ojo — Roadmap

Six planned pieces of work, grouped into the order they're being built. The
grouping isn't arbitrary: several of the items share components or data, and
doing them separately means building the same thing twice.

| Phase | What | Status |
|-------|------|--------|
| 0 | Perf quick wins | done |
| 1 | Shared match-status model | done |
| 2 | Web: merged library page + processing/analysing UI | todo |
| 3 | iOS: merged Matches + Profile, "Upload & AI Analyse" | todo |
| 4 | Remaining UX (fullscreen, login, caching, SSR) | todo |
| 5 | Media pipeline: faststart + analysis proxy | todo |

## Why these groupings

- **Web merge and the analysing/processing UI are the same components.** The
  status chip on a match card *is* the processing UI; splitting them means
  touching the library page, `FeedCard` and the watch page twice.
- **Web and iOS need one status vocabulary**, so it's defined server-side once
  (phase 1) and both clients just render it.
- **faststart and the 4 GB limit are one pipeline.** Both are "run ffmpeg over
  the file in S3 after upload, flip a status when done". The S3 trigger, job
  tracking, status columns and processing UI are shared.

---

## Phase 0 — Perf quick wins

Small, low-risk, and everything in later phases renders on these pages.

1. **Cacheable signed URLs.** `getThumbnailUrl` / `getPlaybackUrl` signed with
   `dateLessThan: now + TTL`, so the signature differed on every request and the
   browser could never reuse a thumbnail. Expiries are now rounded up to a fixed
   bucket, so the same URL comes back for a whole window.
2. **One auth round trip, not two.** The middleware validated the session with
   `auth.getUser()` (a network call to Supabase), then every route handler did it
   again. The middleware now passes the verified user id downstream on a header.
3. **Profile page waterfall.** It ran four sequential Supabase calls from the
   browser and didn't use `/api/users/[id]`, which already returns most of it.
   Now a single request to `/api/users/me`.
4. **Parallel independent awaits** in the watch detail route and
   `profileSummary`.

## Phase 1 — Shared match-status model

One derived state per match, computed server-side and returned by `/api/videos`
and the detail route:

- **upload** — `uploading` / `processing` / `ready` / `failed`
- **analysis** — `none` / `analysing` / `ready` / `failed`
- **share** — `private` / `link` / `followers` / `public`

Lives in `lib/matchStatus.ts` — the derivation plus the chip labels and a
four-value `Tone` vocabulary that web CSS and SwiftUI can both map.
`MetadataStore.list()` now reports the two share facts it was missing (a live
share link, and whether the caller posted the match to their followers), fetched
in bulk for the whole library rather than per card.

Served as a **new** `matchStatus` field on `/api/videos` and the detail route —
not a richer `status`. The existing `status` is a bare string that both clients
already decode (iOS as a non-optional `String`), so replacing it would break the
iOS Matches tab.

## Phase 2 — Web: merged library page

Fold `/matches`, `/profile` and `/upload` into one page — profile header, inline
upload, match grid. Cards get the phase-1 status tag plus AI Breakdown and Share
buttons. Processing and analysing become real states with progress and elapsed
time, since a TwelveLabs run on a full match takes minutes.

Keep `/upload` and `/matches` as redirects — the iOS app builds `watchURL` and
existing shared links point at the old paths.

## Phase 3 — iOS: merged Matches + Profile

Profile layout as the base, matches in a grid with the phase-1 status chip —
including local not-yet-uploaded recordings, which only iOS can show.
"Upload & AI Analyse" chains upload completion into `POST /analyze` so analysis
starts without a second visit; the CTA becomes "Share" once ready.

Also here, because it's the same file: **`BackgroundUploader` writes the entire
video out a second time** as part files before enqueuing anything, so a 6 GB
match needs 12 GB free, and it presigns every part sequentially before a single
byte uploads (~750 round trips at 8 GB / 8 MB parts). Scale part size with file
size (target ~300 parts) and presign in batches.

## Phase 4 — Remaining UX

Server Components for initial payloads, skeletons instead of "Loading…",
fullscreen viewing, the login page, and iOS-side caching of profile/library
responses.

## Phase 5 — Media pipeline

One S3-triggered job, two outputs: a faststart-remuxed MP4 for smooth scrubbing,
and a downscaled analysis proxy that keeps a 2-hour match under the TwelveLabs
4 GB limit. Status flows into the phase-1 model, so the UI already exists.

Last because it's the only item needing new AWS infra, real running cost and a
new deploy surface — and the 4 GB stopgap (a clear error message, see
`app/api/videos/[id]/analyze/route.ts`) means nobody is hard-blocked.

**Open decision.** MediaConvert is managed but re-encodes everything; there's no
remux-only path, so the master would be recompressed. ffmpeg on Fargate can
stream-copy the faststart output and transcode the proxy in one pass, at the cost
of more code — currently the leaning option. Lambda is out for the proxy: a
2-hour transcode won't finish in 15 minutes.

**Check first:** whether scrubbing is actually broken today. Browsers do handle a
trailing `moov` atom via range requests. If seeking is acceptable on real
matches, this phase shrinks to just the analysis proxy.
