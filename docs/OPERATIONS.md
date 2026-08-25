# Ojo — how it runs, what it costs, how to ship it

Written for scaling past the "me and friends" stage. Where a number is measured,
it says so; where it's an estimate, it says that too.

---

## 1. Life of a recording

### Record (iPhone)
`CameraRecorder` captures H.264 at 1080p, locked landscape, 30 fps, at a **pinned
8 Mbps** — about **4 GB/hour**. The file lands in the app's Documents directory and
is indexed by `RecordingLibrary`, so it survives relaunches.

Capture used to run at AVFoundation's default for `.hd1920x1080`, which measured
**15.4 Mbps**: a 33-minute match was 3.6 GB and a 61.8-minute one 7.14 GB. That
filled a 64 GB phone and made every match an hour of phone-radio upload. Pinning
the bitrate roughly halves both. Nothing that matters loses out — `analysisProxy.ts`
establishes empirically that the AI breakdown is indistinguishable at 1080p
~1.7 Mbps, so analysis keeps ~4.7× headroom, and resolution (the axis that decides
whether the ball is visible) is unchanged.

Two knock-ons, both good: a match now has to run past **~33 minutes** rather than
~17 to exceed `PROXY_THRESHOLD_BYTES`, so shorter matches skip the Fargate proxy
and go straight to analysis; and `partSizeFor` yields proportionally smaller parts,
still far above S3's 5 MiB floor.

Recording also refuses to start below ~10 minutes of recordable space, and
`minFreeDiskSpaceLimit` stops a running capture before the volume fills — cleanly,
so the footage up to that point stays playable. Both surface in the camera UI.

The recording exists only on the phone at this point. Nothing is uploaded until
you ask.

### Upload
Tapping **Upload & AI Analyse** (or **Retry**) starts `BackgroundUploader`:

1. `POST /api/uploads/initiate` — creates the `videos` row (`status=uploading`)
   and an S3 multipart upload. The server picks the part size from the file size
   (`partSizeFor`), targeting ~300 parts, so a 6 GB match uses 20 MiB parts rather
   than 750 × 8 MiB.
2. Parts are sliced, presigned and uploaded **24 at a time**, refilled from the
   `URLSession` delegate as each lands. Bytes go phone → S3 directly; they never
   pass through the web app.
3. `POST /api/uploads/:id/complete` assembles the object and sets `status=ready`.
4. The poster thumbnail uploads, and only once the server confirms it holds a good
   copy does the phone delete its local file.

Uploads run on a background `URLSession`, so they continue while the app is
suspended and resume across relaunches.

### Why an upload doesn't fail any more
A 45-minute match is ~300 parts and half an hour of a phone radio. A dropped
connection, a Wi-Fi/cellular hand-off, an S3 `SlowDown`, or a presigned URL that
outlived its hour is a certainty over that window, not an edge case — and each of
those used to fail the *whole* match, which is why a long recording routinely took
three or four attempts to get through. Three things stop that now:

- **Retry is per part, not per match.** A failed PUT re-presigns and re-enqueues
  that one part with exponential backoff + jitter (`maxPartAttempts = 8`),
  scheduled with `earliestBeginDate` so the backoff still elapses while the app is
  suspended. A 403 from an expired URL heals itself, because the retry mints a new
  one. Only a part that fails eight times running fails the job.
- **Retry resumes; it never restarts.** The job file names an S3 multipart upload
  that is still open, so a retry calls `GET /api/uploads/:id/list-parts` first and
  keeps every part S3 already holds (sizes are checked before an ETag is trusted).
  A match that died at part 280 of 300 finishes in a minute instead of re-sending
  5 GB. This is why a failed upload's job is kept on disk rather than deleted.
- **`complete` can't lose the transfer.** Once every part has landed the job is
  latched to `completing` *before* the call goes out, so an app that's suspended
  or killed mid-`complete` retries the finish on next launch instead of
  re-uploading the match. If S3 rejects the part list, it's rebuilt from
  `list-parts` (S3's own view is authoritative) and retried; if an earlier attempt
  actually landed and we never heard back, `GET /api/videos/:id` reveals that and
  the upload is adopted.

A background task's description is `recordingId|videoId|partNumber`. The `videoId`
is load-bearing: without it, a task left over from an abandoned attempt would
record its ETag against the *new* attempt's part — an ETag from a different
multipart upload — and `complete` would fail with `InvalidPart`.

### Reading the upload log
`UploadLog` writes every step to the unified log and to a capped `upload.log` in
the app's Documents directory, so a failure that happened on a court hours ago can
still be read back. With the phone attached:

```
log stream --predicate 'subsystem == "com.ojotennis.app"' --info
```

Or pull `upload.log` out of the container via Xcode → Window → Devices &
Simulators → the app → Download Container.

### Analysis
Triggered three ways, all landing on `POST /api/videos/:id/analyze`:
- iOS **Upload & AI Analyse** — chained automatically when the upload completes
- the web library card's **AI Breakdown** button
- the watch page's setup panel (the only one offering warm-up trim + player names)

Then, depending on size:

```
master ≤ ~2 GB   →  analysed directly
master > ~2 GB   →  Fargate builds a 1080p proxy first, then the proxy is analysed
```

The proxy path sets `analysis_status=processing` with **no** `analysis_task_id` —
that combination is what distinguishes "compressing" from "analysing". When the
container sets `has_analysis_proxy`, the next poll hands the proxy's signed URL to
TwelveLabs.

**Proxies are kept for 48 hours after a run, not deleted.** Rebuilding one costs
~16 minutes of Fargate, so a retry within that window skips straight to analysis;
the `expire-analysis-proxies` lifecycle rule on the `proxies/` prefix is what
removes them (`analysis_proxy_retention_days` in Terraform). S3 expiration is
day-granular and evaluated once a day, so 48h is the earliest removal, not a
guarantee — the app HEADs the object before using a proxy rather than trusting
`has_analysis_proxy`, and re-transcodes if it has gone. Deleting a match still
removes its proxy immediately.

Results run through `smoothTennis`, which fits tennis's rigid structure (server
alternates each game, games ≥4 points, ends change every 2 games) to the model's
noisy per-point guesses.

### Advancing a run without an open tab
`GET /analyze` polls TwelveLabs and writes results back — and for a long time that
was the *only* thing that did, so closing the tab paused a run.

`GET /api/cron/advance-analyses` now does the same step for every in-flight match,
under the service role, on a schedule. Both callers share `lib/analysisRunner.ts`
so they can't diverge, and every step is idempotent — Vercel explicitly warns that
cron delivery is best-effort and can double-fire, so re-running a step is safe by
design.

It authenticates with `CRON_SECRET` (`Authorization: Bearer <secret>`) and **fails
closed**: with no secret configured it returns 503 rather than running unprotected.
`/api/cron` is exempted from the middleware's auth check, since a scheduler has no
session — the secret is what protects it.

**⚠️ Hobby-plan limit.** Vercel Hobby allows cron **once per day**, and a more
frequent expression *fails the deployment*. `vercel.json` therefore ships
`0 3 * * *`. That's a daily safety net, not a real worker: between sweeps, runs
still only advance while someone has the page open.

**The real cadence comes from Postgres.** `supabase/migrations/0012_schedule_analysis_sweep.sql`
uses `pg_cron` + `pg_net` to call the same endpoint every 5 minutes. No third-party
account, no plan limit, and the bearer token lives in Supabase Vault rather than in
the job definition. The Vercel daily cron stays as a backstop.

The endpoint is idempotent, so Postgres, Vercel and an open browser tab can all
drive it at once without conflict.

Check it:
```sql
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'ojo-advance-analyses')
order by start_time desc limit 5;

select status_code, content, created from net._http_response
order by created desc limit 5;   -- 200 swept · 401 secret mismatch · 503 no CRON_SECRET
```

On Vercel Pro you could drop all this and use `*/5 * * * *` in `vercel.json`.

---

## 2. Time and accuracy

### Time
| Stage | 33 min | 2 hours | Basis |
|---|---|---|---|
| Upload (50 Mbps up) | ~10 min | ~37 min | arithmetic |
| Upload (10 Mbps up) | ~50 min | ~3 h | arithmetic |
| Proxy transcode | n/a | ~45–60 min | **estimate**, x264 veryfast on 4 vCPU |
| TwelveLabs analysis | ? | ? | **not measured** |

Upload dominates on a slow connection. The transcode figure is an educated guess
until a real Fargate task has run; it has not been benchmarked. TwelveLabs
turnaround has never been timed — your own runs are the only data available.

### Accuracy
**Measured, n=1:** on a 33-minute match, a 1080p proxy at ~1.7 Mbps produced a
breakdown indistinguishable from the original. A 720p proxy at the same file size
lost the ball, which is why the spec keeps resolution and scales bitrate.

Accuracy depends far more on how the match is played than on its length:

- **Helped by length.** The smoother fits phase to the whole match, so more games
  means a better-constrained fit. `serverAgreementWithRaw` in the smoother report
  is the confidence number to watch.
- **Hurt by non-standard structure.** It assumes the server alternates every game
  and a game is ≥4 points. Tiebreaks, casual hitting without service games, and
  matches with no changeovers all violate that. A "constant near player" candidate
  exists for the no-changeover case; nothing covers a tiebreak.
- **Hurt by ball visibility.** `times_ball_was_hit` is the weakest field. The
  smoother already overrides it with a duration-derived floor, so rally boundaries
  survive even when the count doesn't.
- **Hard limit: 2 hours.** Pegasus rejects longer video regardless of file size.

---

## 3. Cost

Per match, at eu-west-1 list prices (Aug 2026).

| Match | Master | Storage/mo | Transcode | TwelveLabs | 1 full watch |
|---|---|---|---|---|---|
| 33 min | 3.8 GB | $0.09 | $0.14 | **$0.97** | $0.33 |
| 1 hour | 6.9 GB | $0.16 | $0.25 | **$1.75** | $0.59 |
| 2 hours | 13.8 GB | $0.32 | $0.50 | **$3.50** | $1.17 |

**TwelveLabs dominates everything else combined.** The Fargate-vs-MediaConvert
decision saved ~$1.30 per match; the analysis itself is 7× the transcode cost.

### ⚠️ Unresolved: is indexing billed on our path?
TwelveLabs lists indexing at **$0.042/min** and Analyze input video at
**$0.0292/min**. We use the async analyze endpoint with a public URL and never
create an index — but the pricing page doesn't say whether that path also incurs
the indexing charge.

If it does, the 2-hour figure is **$8.54, not $3.50**.

**Settle this from your actual invoice** — you've already run analyses, so the
billing dashboard answers it definitively. Everything else here is arithmetic; this
one number could be 2.4× off.

Free tier: 600 minutes of indexing, indexes expire after 90 days.

### What scales badly
1. **Master storage grows forever.** 15.3 Mbps is a lot. Ten users × 4 matches ×
   2 h per month ≈ 550 GB/month accumulating — $13/month in month one, $150/month
   by month twelve, and it never stops.
2. **CloudFront egress exceeds transcoding.** One full watch of a 2-hour match is
   $1.17. Rewatching is the expensive habit, not analysing.
3. **The obvious lever is the recording bitrate.** Storing a ~6 Mbps review master
   instead of 15.3 Mbps would halve both storage and egress with little visible
   loss at review resolution. It trades against "maintain the video quality" — but
   it's the only change that bends the recurring curve rather than the per-match one.

Add a lifecycle rule moving masters to S3 Infrequent Access (or Glacier IR) after
30–60 days if matches are watched mostly when fresh; that's a ~40–70% cut on the
storage line for anything cold.

---

## 4. Deleting a recording

| Where | Who | What happens |
|---|---|---|
| iOS — long-press a match → **Delete match** | owner | cancels any upload, `DELETE /api/videos/:id`, removes the local file, thumbnail and index entry |
| Web — watch page → **Edit** → delete | owner | `DELETE /api/videos/:id` |
| Web — library card → **Remove** | non-owner | removes it from *your* library only; the match itself is untouched |

`DELETE /api/videos/:id` does two things:
1. **Soft-delete** — sets `deleted_at`. RLS then hides it everywhere; the row
   stays for referential integrity (comments, likes, library entries).
2. **Byte purge** — deletes the master, the thumbnail and any analysis proxy from
   S3.

Notes for scale:
- **There is no hard delete.** Rows persist indefinitely. A GDPR-style erasure
  request currently has no path; worth building before you have real users.
- The purge is best-effort and swallows errors. It also **required an IAM fix**:
  the web app's policy had no `s3:DeleteObject`, so byte purges had been failing
  silently. Applying the current Terraform fixes it — but objects deleted before
  that are still in the bucket and need a one-off sweep.
- Segments cascade on a hard row delete, but a soft delete leaves them.

---

## 5. Shipping to production

In order. Steps 1–3 create billable AWS resources.

### 1. Database
Supabase → SQL editor → run, in order, any migrations not yet applied. For this
work that's:

```
supabase/migrations/0011_analysis_proxy.sql
supabase/migrations/0013_analysis_windows.sql
supabase/migrations/0017_notifications.sql
supabase/migrations/0019_events.sql
supabase/migrations/0020_schedule_events_retention.sql
```

**0013 must be applied before the deploy that ships windowed analysis**, not
after: the new code writes `videos.analysis_windows` when it starts a long
match, and without the column every such run fails on its first write. The
migration is additive and safe to run against the current code, which ignores
the column.

**0017 must be applied before the deploy that ships @tags**, for the same
reason from the other end: the notifications the clients read are written by a
trigger that only exists once the migration has run, so shipping the UI first
gives everyone a permanently empty inbox and no error to explain it. It is
additive and safe to run early — against the current code it just starts filling
a table nothing reads yet. Verify it locally first with
`supabase/tests/run.sh`, which now includes a `notifications` suite covering who
the fan-out reaches and who it must not.

**0019 and 0020 are the analytics tables** (see [`ANALYTICS.md`](ANALYTICS.md)).
Unlike 0013 and 0017 nothing breaks if they lag the deploy — every write goes
through one route that fails soft — but nothing is *recorded* either, silently,
which is a bad thing to discover in a month. Run them with the deploy.

Two things to check afterwards, because both fail quietly rather than loudly:

- **`SUPABASE_SERVICE_ROLE_KEY` is set in Vercel.** Without it `analyticsEnabled()`
  is false and every event is dropped with no error. It is already needed for the
  analysis cron sweep, so a correct environment has it — worth confirming rather
  than assuming.
- **The retention job is scheduled.** `select * from cron.job where jobname =
  'ojo-prune-events';` should return a row. `/privacy` commits to a twelve-month
  window, and 0020 is what makes that true rather than aspirational.

### 2. Infrastructure
```bash
cd infra
```
Add to `infra/terraform.tfvars` (gitignored):
```hcl
supabase_url              = "https://<ref>.supabase.co"
supabase_service_role_key = "<service role key>"
```
Then:
```bash
terraform plan     # read it — it also adds s3:DeleteObject to the app user
terraform apply
```

### 3. Transcoder image
```bash
cd infra/transcoder
REPO=$(cd .. && terraform output -raw TRANSCODER_ECR_REPOSITORY_URL)
aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/amd64 -t "$REPO:latest" .
docker push "$REPO:latest"
```
`--platform linux/amd64` is required on Apple Silicon, or the task fails to start.

### 4. Web environment

`SUPABASE_SERVICE_ROLE_KEY` **must be set in Vercel** — the cron sweep needs it to
see every user's rows. Before the sweep existed, nothing deployed read this
variable (only the local thumbnail script), so an otherwise-working project can
easily be missing it. Without it the sweep returns 503 and does nothing.

```bash
cd infra
terraform output TRANSCODE_ECS_CLUSTER TRANSCODE_TASK_DEFINITION \
  TRANSCODE_CONTAINER_NAME TRANSCODE_SUBNETS TRANSCODE_SECURITY_GROUPS
```
Add all five to the Vercel project's environment variables. Until they're all set,
an oversized match reports that compression isn't configured.

### 5. Deploy the web app
Merge to `main`; Vercel auto-deploys from the `web` root. Deployment Protection
must stay **off** so the iOS app and shared links can reach `/api/*`.

### 6. iOS
`UploadAPI.Config.apiBaseURL` already points at `https://ojotennis.com`. Build to
a device from `ios/Ojo/`. TestFlight needs a paid Apple
Developer account.

### 7. Verify end to end
1. Record a short match → **Upload & AI Analyse** → breakdown appears.
2. Record (or upload) something over ~2 GB → confirm the card shows *compressing*,
   then *analysing*, then results.
3. `aws logs tail /ecs/tennis-transcoder --follow` during that run.
4. Confirm `proxies/<id>.mp4` is **still there** afterwards (retained 48h), and
   that an immediate retry goes straight to *analysing* without re-compressing.
5. Delete a match; confirm the master and thumbnail leave the bucket.

### Before real users
- [x] Server-side poller so analyses don't depend on an open tab (§1) — pg_cron
      every 5 min, verified returning 200 in production; Vercel's daily run is a
      backstop
- [ ] Settle the TwelveLabs indexing question from an invoice (§3)
- [ ] One-off sweep for objects orphaned by the old missing `s3:DeleteObject`
- [ ] A hard-delete path for erasure requests (§4)
- [ ] S3 lifecycle rule for cold masters (§3)
