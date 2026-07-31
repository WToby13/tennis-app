# Copy these into web/.env (secrets are marked sensitive — read them with
# `terraform output <name>`). See infra/README.md for the exact mapping.

output "AWS_REGION" {
  value = var.aws_region
}

output "S3_BUCKET" {
  value = aws_s3_bucket.videos.bucket
}

output "CLOUDFRONT_DOMAIN" {
  value = aws_cloudfront_distribution.videos.domain_name
}

output "CLOUDFRONT_KEY_PAIR_ID" {
  value = aws_cloudfront_public_key.videos.id
}

# The app accepts the private key as base64 (avoids multi-line env headaches).
output "CLOUDFRONT_PRIVATE_KEY" {
  value     = base64encode(tls_private_key.cf.private_key_pem)
  sensitive = true
}

output "AWS_ACCESS_KEY_ID" {
  value     = aws_iam_access_key.app.id
  sensitive = true
}

output "AWS_SECRET_ACCESS_KEY" {
  value     = aws_iam_access_key.app.secret
  sensitive = true
}
