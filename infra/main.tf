locals {
  name = var.project
}

# Random suffix so the bucket name is globally unique.
resource "random_id" "suffix" {
  byte_length = 4
}

# --- S3: private bucket for the videos ---------------------------------------

resource "aws_s3_bucket" "videos" {
  bucket = "${local.name}-videos-${random_id.suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "videos" {
  bucket                  = aws_s3_bucket.videos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Browser uploads PUT parts straight to S3 via presigned URLs, so the bucket must
# allow those origins and expose the ETag response header to JS.
resource "aws_s3_bucket_cors_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# Clean up parts from uploads that never completed, and expire analysis proxies.
resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {} # apply to all objects
    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }

  # Analysis proxies are disposable re-encodes made to fit TwelveLabs' input
  # limit. The app deliberately no longer deletes them when a run finishes:
  # rebuilding one costs ~16 minutes of Fargate, so keeping it makes a retry
  # near-instant. This rule is what stops them accumulating.
  #
  # S3 expiration is evaluated once a day and applies to objects OLDER than
  # `days`, so removal happens at 48h at the earliest and possibly later. The
  # app treats that as a floor, not a promise: it HEADs the object before using
  # one rather than assuming a proxy younger than 48h is still present.
  rule {
    id     = "expire-analysis-proxies"
    status = "Enabled"
    filter {
      prefix = "proxies/"
    }
    expiration {
      days = var.analysis_proxy_retention_days
    }
  }
}

# --- CloudFront: private distribution with signed-URL access -----------------

resource "aws_cloudfront_origin_access_control" "videos" {
  name                              = "${local.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# RSA key pair used to sign playback URLs. Terraform generates it and hands the
# private key to the app via an output; CloudFront gets the public key.
resource "tls_private_key" "cf" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "videos" {
  name        = "${local.name}-signing-key"
  encoded_key = tls_private_key.cf.public_key_pem
  comment     = "Playback URL signing key for ${local.name}"
}

resource "aws_cloudfront_key_group" "videos" {
  name  = "${local.name}-key-group"
  items = [aws_cloudfront_public_key.videos.id]
}

# Managed cache policy tuned for static/immutable content (objects are addressed
# by an immutable per-video key, so aggressive caching is safe).
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "videos" {
  enabled     = true
  comment     = "${local.name} video playback"
  price_class = var.price_class

  origin {
    domain_name              = aws_s3_bucket.videos.bucket_regional_domain_name
    origin_id                = "s3-videos"
    origin_access_control_id = aws_cloudfront_origin_access_control.videos.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-videos"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

    # Only requests carrying a valid signature from this key group are served.
    trusted_key_groups = [aws_cloudfront_key_group.videos.id]
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Allow only this CloudFront distribution (via OAC) to read objects.
data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.videos.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.videos.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "videos" {
  bucket = aws_s3_bucket.videos.id
  policy = data.aws_iam_policy_document.bucket.json
}

# --- IAM: least-privilege user for the web app (multipart uploads) -----------

resource "aws_iam_user" "app" {
  name = "${local.name}-web-app"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid = "MultipartObjectOps"
    # DeleteObject covers the byte purge after a soft-delete and the analysis-proxy
    # cleanup. Both call DeleteObject best-effort and swallow failures, so without
    # this the objects were silently left behind.
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.videos.arn}/*"]
  }
  statement {
    sid       = "ListBucketUploads"
    actions   = ["s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.videos.arn]
  }
}

resource "aws_iam_user_policy" "app" {
  name   = "${local.name}-s3-multipart"
  user   = aws_iam_user.app.name
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_access_key" "app" {
  user = aws_iam_user.app.name
}
