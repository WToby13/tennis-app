# Infra — S3 + CloudFront (Terraform)

Provisions the video backend in **your own AWS account**: a private S3 bucket, a
CloudFront distribution that serves it over signed URLs only, the RSA signing key,
and a least-privilege IAM user for the web app. Nothing here is shared with anyone
else — it all lives in whatever account your AWS credentials point to.

## What gets created

| Resource | Purpose |
|----------|---------|
| S3 bucket (private, all public access blocked) | stores the video objects |
| Bucket CORS (PUT/GET/HEAD, exposes `ETag`) | lets the browser PUT parts directly |
| Bucket lifecycle rule | auto-aborts incomplete multipart uploads after 7 days |
| CloudFront distribution + Origin Access Control | serves the private bucket over HTTPS |
| CloudFront public key + key group | enforces **signed-URL-only** playback |
| RSA key pair (via Terraform `tls` provider) | signs playback URLs |
| IAM user + access key + policy | the web app's S3 multipart permissions |

## Prerequisites

- Terraform ≥ 1.5 (you have 1.14.5 ✓)
- AWS credentials for **your private account** with permission to create the above.
  Set them however you prefer, e.g.:
  ```bash
  export AWS_ACCESS_KEY_ID=...
  export AWS_SECRET_ACCESS_KEY=...
  export AWS_REGION=eu-west-1
  ```
  (These are *your admin* credentials for running Terraform — separate from the
  limited `tennis-web-app` user Terraform creates for the app itself.)

## Apply

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # edit region + allowed_origins
terraform init
terraform apply
```

CloudFront takes ~5–15 min to deploy. When it's done, read the outputs into `web/.env`:

```bash
cd infra
{
  echo "STORAGE_BACKEND=s3"
  echo "AWS_REGION=$(terraform output -raw AWS_REGION)"
  echo "S3_BUCKET=$(terraform output -raw S3_BUCKET)"
  echo "CLOUDFRONT_DOMAIN=$(terraform output -raw CLOUDFRONT_DOMAIN)"
  echo "CLOUDFRONT_KEY_PAIR_ID=$(terraform output -raw CLOUDFRONT_KEY_PAIR_ID)"
  echo "CLOUDFRONT_PRIVATE_KEY=$(terraform output -raw CLOUDFRONT_PRIVATE_KEY)"
  echo "AWS_ACCESS_KEY_ID=$(terraform output -raw AWS_ACCESS_KEY_ID)"
  echo "AWS_SECRET_ACCESS_KEY=$(terraform output -raw AWS_SECRET_ACCESS_KEY)"
} >> ../web/.env
```

Then `cd web && npm run dev` — the app now uses real S3 multipart and signed
CloudFront playback. (`web/.env` is gitignored.)

## Notes

- **State holds secrets.** `terraform.tfstate` contains the private key and IAM
  secret. It's gitignored here; for a shared setup use a remote backend (e.g. an
  S3 backend with encryption) instead of local state.
- **Uploading straight to CloudFront won't work** — uploads go to S3 (presigned
  PUT), playback comes from CloudFront. That split is intentional.
- **faststart:** iPhone `.mov`/`.mp4` files put the `moov` atom at the end, so they
  won't scrub in the browser until remuxed. That Lambda isn't built yet, so leave
  `FASTSTART_ENABLED` unset (videos are marked ready immediately). When you add the
  Lambda, set `FASTSTART_ENABLED=true` and have it flip status → `ready`.
- **Teardown:** `terraform destroy` removes everything. Empty the bucket first if it
  contains objects (`aws s3 rm s3://<bucket> --recursive`, or add `force_destroy`).
