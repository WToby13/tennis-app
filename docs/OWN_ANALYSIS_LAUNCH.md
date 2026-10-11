# Launching our own analysis

What's needed to go from the `ml/` prototype to analysis showing up on every
match in the app, in order. The pipeline itself is described in
[`ml/README.md`](../ml/README.md).

## 1. Turn on the app side (no user-visible change yet)

1. Run `supabase/migrations/0023_match_analyses.sql` in the Supabase SQL editor.
   It adds the `match_analyses` table (readable by anyone who can see the match,
   written only by the service role).
2. Set `ANALYSIS_WORKER_SECRET` in the app's environment (Vercel → Settings →
   Environment Variables): any long random string, e.g. from `openssl rand -hex 32`.
   Both worker routes refuse everything while it's unset.
3. Deploy (merge #4 → #5 → #6, or deploy the branch).

Until a match has a row in `match_analyses`, its watch page looks exactly as it
does today: the new "Shot analysis" section renders nothing.

## 2. Backfill our own recordings

With `OJO_APP_URL` and `ANALYSIS_WORKER_SECRET` in the environment:

```bash
cd ml
# Court: automatic pins; the panel asks for a check where it isn't sure.
.venv/bin/python -m ojo_replay.autocal .cache/videos/<id>.mov out/autocal/<id>.json
.venv/bin/python -m ojo_replay.post_calibration <video-uuid> out/autocal/<id>.json
# Analysis: shots, rallies, games.
.venv/bin/python -m ojo_replay.analyze <id> && .venv/bin/python -m ojo_replay.structure <id>
.venv/bin/python -m ojo_replay.post_analysis <id>
```

A hand calibration is never overwritten by an automatic one (the route answers 409).

## 3. Measure before switching anything off

- Tag one or two matches in the labeller (`node ml/viewer/label-server.mjs`,
  then <http://localhost:8766>) and score them: `python -m ojo_replay.evaluate <id>`.
- The bar for showing shot stats to users without a "Beta" label: hit recall and
  precision both above ~85% on tagged matches, serving end above ~95%.
- Today: shot recall is the gap (the fit catches a minority of shots on cameras
  ~20 m back). Player identity, serving end and games work on the points found.

## 4. Run it for every upload

The prototype runs on a laptop. For every upload it needs a GPU worker:

- **Where:** AWS Batch on GPU spot instances (g6.xlarge, NVIDIA L4) in eu-west-1
  next to the bucket, scaling to zero; or a serverless GPU host.
- **Trigger:** the same place the TwelveLabs analysis starts today
  (`/api/videos/:id/analyze` and the advance-analyses cron) submits a job with
  the video id; the worker downloads the master from S3, runs
  `autocal → analyze → structure`, and posts to the two worker routes.
- **Cost (estimate until benchmarked on a real L4):** ~$0.20 (spot) to $0.50
  (on demand) per hour of match today, ~$0.10–0.20 after the planned speed-ups,
  against TwelveLabs' $1.94.
- **Licences to settle first:** YOLO11 is AGPL-3.0 (a commercial licence from
  Ultralytics, or switch to an Apache-licensed pose model such as RTMPose);
  WASB (ball) is MIT.

## 5. Switch TwelveLabs off

Run both side by side on new uploads for a few weeks; when ours matches or beats
it on tagged matches, stop calling TwelveLabs and move the rally breakdown onto
our own rallies and games.
