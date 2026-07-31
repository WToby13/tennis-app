variable "aws_region" {
  description = "AWS region for the bucket."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  description = "Name prefix for created resources."
  type        = string
  default     = "tennis"
}

variable "allowed_origins" {
  description = "Web origins allowed to upload parts directly to S3 (browser CORS). Add your Vercel URL here."
  type        = list(string)
  default     = ["http://localhost:3000"]
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = cheapest (US + EU edges)."
  type        = string
  default     = "PriceClass_100"
}

variable "abort_incomplete_multipart_days" {
  description = "Auto-abort incomplete multipart uploads after this many days."
  type        = number
  default     = 7
}
