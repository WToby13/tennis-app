# Launching our own analysis

From the `ml/` pipeline to every match in the app analysed by our own models,
with TwelveLabs switched off. The pipeline itself is described in
[`ml/README.md`](../ml/README.md); this is the runbook.

Everything below the demo is opt-in and reversible: with no new settings the
app behaves exactly as today.

## 0. Demo it locally (no accounts, nothing in production)

```bash
cd ml && .venv/bin/python -m ojo_replay.demo_local f85eedfd 08f3fb94   # load analysed matches
cd .. && MATCH_STATS_DIR=../ml/out/match-stats npm --prefix web run dev:local
# open http://localhost:3100 (or the "ojo-demo-local" launch config)
```

On a match's watch page:
- **AI breakdown** shows our rallies, servers and service games (what
  `ANALYSIS_ENGINE=own` produces).
- **Show tracking** draws the ball, both players (A/B by kit colour) and each
  bounce with its speed over the playing video.
- **Shot analysis (Beta)** below: shot map (tap a bounce to jump there),
  per-player serve and rally speeds, in/net, first serves, distance run, and
  the service games.

## 1. App side, still on TwelveLabs (side by side)

1. Run `supabase/migrations/0023_match_analyses.sql` in the Supabase SQL editor
   (table `match_analyses`: stats + tracking per match, readable wherever the
   match is, written only by the service role).
2. Set `ANALYSIS_WORKER_SECRET` in Vercel (`openssl rand -hex 32`).
3. Deploy (merge #4 → #5 → #6).

Nothing changes for users until a match has an analysis row; then the Shot
analysis section and "Show tracking" appear on it, next to TwelveLabs'
breakdown.

## 2. Backfill our own recordings (from a laptop)

```bash
cd ml
export OJO_APP_URL=https://<the app> ANALYSIS_WORKER_SECRET=<same secret>
.venv/bin/python -m ojo_replay.autocal .cache/videos/<id>.mov out/autocal/<id>.json
.venv/bin/python -m ojo_replay.post_calibration <video-uuid> out/autocal/<id>.json
.venv/bin/python -m ojo_replay.analyze <id> && .venv/bin/python -m ojo_replay.structure <id>
.venv/bin/python -m ojo_replay.post_analysis <id>
```

(A hand calibration is never overwritten by an automatic one.)

## 3. The GPU worker (AWS Batch, scales to zero)

```bash
cd infra
# terraform.tfvars: worker_app_url = "https://<the app>", analysis_worker_secret = "<same secret>"
terraform plan && terraform apply           # analysis_worker.tf: ECR, Batch on g6.xlarge spot, IAM
cd .. && ml/docker/build.sh "$(terraform -chdir=infra output -raw analysis_worker_ecr)"
```

Then in Vercel set `ANALYSIS_BATCH_JOB_QUEUE` and `ANALYSIS_BATCH_JOB_DEFINITION`
to the Terraform outputs. Until `ANALYSIS_ENGINE=own` nothing submits jobs.
Note: AWS accounts start with a GPU spot quota of 0 vCPUs for G instances;
request "All G and VT Spot Instance Requests" ≥ 8 in Service Quotas first.

Any machine can also be a worker: `python -m ojo_replay.worker` polls the app
for queued matches (useful on the Mac before Batch is up).

## 4. Switch the breakdown to our engine

Set `ANALYSIS_ENGINE=own` in Vercel and redeploy. "AI breakdown" then queues
the match (`ojo:queued`), the app submits a Batch job, the worker claims it,
analyses it and posts the result, which fills the same rally breakdown
TwelveLabs did and finishes the run. Failures show the owner a message.
Revert by setting it back to `twelvelabs`.

## 5. The accuracy bar, then switch TwelveLabs off

Measured against hand tags (`ml/labels/`, scored with
`python -m ojo_replay.evaluate <id>`, held out across matches):

| | Now | Bar to drop "Beta" |
|---|---|---|
| Points found | 94–97% | ≥ 95% |
| Serving end | 75–95% | ≥ 95% |
| Hits found | 43–61% | ≥ 85% |
| Hits that are real | 58–66% | ≥ 85% |

When ours meets the bar on a few tagged matches, stop calling TwelveLabs
(remove `TWELVELABS_API_KEY`), and delete `web/lib/twelvelabs/` and the
transcoder (`infra/transcoder.tf`), which only exists to make TwelveLabs
proxies.

## Costs (per hour of match)

| | TwelveLabs | Ours (spot GPU) |
|---|---|---|
| Today | $1.94 ($4.27 if indexing is billed) | ~$0.20–0.50 (estimate until benchmarked) |
| After planned speed-ups | | ~$0.10–0.20 |

Scale is linear with no idle cost: 1,000 match-hours a month is ~$1,940 on
TwelveLabs against ~$200–500 ours.

## Licences to settle before charging for it

- YOLO11 (player detection) is AGPL-3.0: buy an Ultralytics licence or swap to
  an Apache-licensed pose model (RTMPose/RTMDet).
- WASB (ball) is MIT. Our hit classifier and code are ours.
