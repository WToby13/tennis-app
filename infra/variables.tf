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

# --- Analysis-proxy transcoder ------------------------------------------------

variable "supabase_url" {
  description = "Supabase project URL. The transcoder uses it to flag a match's proxy as ready."
  type        = string
}

variable "supabase_service_role_key" {
  description = "Supabase service-role key. The transcoder writes one column with it; keep it out of git."
  type        = string
  sensitive   = true
}

variable "transcoder_cpu" {
  description = "Fargate vCPU units. 4096 = 4 vCPU; x264 scales well across cores."
  type        = string
  default     = "4096"
}

variable "transcoder_memory" {
  description = "Fargate memory (MiB). Must be a valid pairing for transcoder_cpu."
  type        = string
  default     = "8192"
}

variable "transcoder_disk_gib" {
  description = "Ephemeral disk. Must hold the largest match plus its proxy — a 2h recording is ~13 GB."
  type        = number
  default     = 60
}
