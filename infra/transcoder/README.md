# Analysis-proxy transcoder

A one-shot Fargate task that makes a match small enough for TwelveLabs to accept,
and nothing else. The web app starts one on demand — only when someone asks for a
breakdown — and the proxy is deleted as soon as the run finishes, so no match is
stored twice.

## Why it exists

TwelveLabs won't take the full-quality master: a 33-minute match off the iPhone is
already 3.6 GB at ~15 Mbps, and a 2-hour one would be ~13 GB.

The encode was chosen by experiment, not from the docs. The same match was encoded
two ways at an identical 406 MB and both were run through the real analysis:

| Encode | Result |
|---|---|
| **1080p @ ~1.7 Mbps** | indistinguishable from the original ✅ |
| 720p @ ~1.7 Mbps | the ball is the first thing to go ❌ |

So at a fixed byte budget, spend it on **resolution**, not bitrate — the ball is a
handful of bright pixels, and halving linear resolution loses it outright, while
compression noise at full resolution leaves it detectable.

That rule lives in [`web/lib/analysisProxy.ts`](../../web/lib/analysisProxy.ts),
which is also where the ffmpeg arguments come from. **This container has no
encoding logic of its own** — the arguments arrive via the ECS command override,
so there's exactly one definition of what a proxy is.

## Deploying

Three steps, in order. All of them cost real money, so read `terraform plan` first.

### 1. Infrastructure

`transcoder.tf` needs two new variables. Add them to `infra/terraform.tfvars`
(gitignored):

```hcl
supabase_url              = "https://<ref>.supabase.co"
supabase_service_role_key = "<service role key>"
```

Then:

```bash
cd infra
terraform plan    # read this properly — it also adds s3:DeleteObject to the app user
terraform apply
```

It creates an ECR repo, an ECS cluster (empty clusters are free), a task
definition, two IAM roles, a log group, two SSM parameters, and a security group
in the **default VPC** with no inbound rules. Tasks get a public IP so they can
reach S3 and Supabase — a NAT gateway would cost ~$35/month, which is far more
than the transcoding.

### 2. Image

The task definition points at `:latest`, so the first analysis of a large match
will fail until an image exists.

```bash
cd infra/transcoder
REPO=$(cd ../ && terraform output -raw TRANSCODER_ECR_REPOSITORY_URL)
aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/amd64 -t "$REPO:latest" .
docker push "$REPO:latest"
```

`--platform linux/amd64` matters on an Apple Silicon Mac — the task definition is
x86, and an arm64 image will fail to start with an exec-format error.

### 3. Web app

Copy the outputs into the Vercel project's environment variables:

```bash
cd infra
terraform output TRANSCODE_ECS_CLUSTER TRANSCODE_TASK_DEFINITION \
  TRANSCODE_CONTAINER_NAME TRANSCODE_SUBNETS TRANSCODE_SECURITY_GROUPS
```

Until all five are set, `transcodeEnabled()` is false and an oversized match
reports that compression isn't configured rather than silently doing nothing.

Also run `supabase/migrations/0011_analysis_proxy.sql`, which adds the
`has_analysis_proxy` column the whole flow keys off.

## How a run goes

1. Owner hits **AI Breakdown** on a match over the proxy threshold.
2. The analyze route starts a Fargate task and sets `analysis_status = processing`
   with **no** `analysis_task_id` — that combination is how a poll tells
   "compressing" from "analysing", without another column.
3. The task pulls the master, encodes, uploads to `proxies/<video-id>.mp4`, and
   sets `has_analysis_proxy = true`.
4. The next poll sees the flag, hands the proxy's signed URL to TwelveLabs, and
   stores the returned task id. Normal polling takes over.
5. On ready **or** failed, the proxy is deleted and the flag cleared.

## Cost

Roughly **$0.15 per 2-hour match** (4 vCPU / 8 GB for ~45–60 min). The cluster,
the ECR repo, and the SSM parameters cost nothing at rest. Proxy storage is
transient by design.

## Debugging

Task logs go to CloudWatch at `/ecs/tennis-transcoder`. A task that fails writes
the reason to `videos.analysis_error`, which the UI shows verbatim.

```bash
aws ecs list-tasks --cluster tennis-transcoder --desired-status STOPPED
aws logs tail /ecs/tennis-transcoder --follow
```
