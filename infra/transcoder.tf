# --- Analysis-proxy transcoder (Fargate) --------------------------------------
#
# One short-lived task per match: pull the master from S3, re-encode a smaller
# proxy (see web/lib/analysisProxy.ts for the spec), upload it, flag the row in
# Supabase. The web app starts a task on demand — only when someone asks for a
# breakdown — so matches nobody analyses cost nothing.
#
# Runs in the DEFAULT VPC on public subnets with a public IP. That's deliberate:
# the task needs to reach S3 and Supabase, and a NAT gateway would cost more per
# month (~$35) than the transcoding itself ever will (~$0.15/match). The security
# group allows no inbound traffic at all.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "transcoder" {
  name        = "${local.name}-transcoder"
  description = "Outbound only; the transcoder accepts no inbound connections."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound (S3, ECR, Supabase, CloudWatch)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Image registry -----------------------------------------------------------

resource "aws_ecr_repository" "transcoder" {
  name                 = "${local.name}-transcoder"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep the registry from growing forever — only the last few builds are useful.
resource "aws_ecr_lifecycle_policy" "transcoder" {
  repository = aws_ecr_repository.transcoder.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 5 most recent images."
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# --- Secrets the task needs ---------------------------------------------------
#
# Held in SSM rather than the task definition's plain environment: task-definition
# env is readable by anyone who can describe the task, and RunTask overrides get
# recorded in CloudTrail. Standard SSM parameters are free.

resource "aws_ssm_parameter" "supabase_url" {
  name  = "/${local.name}/transcoder/supabase_url"
  type  = "String"
  value = var.supabase_url
}

resource "aws_ssm_parameter" "supabase_service_role_key" {
  name  = "/${local.name}/transcoder/supabase_service_role_key"
  type  = "SecureString"
  value = var.supabase_service_role_key
}

# --- Logs ---------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "transcoder" {
  name              = "/ecs/${local.name}-transcoder"
  retention_in_days = 14
}

# --- Cluster ------------------------------------------------------------------
#
# An empty Fargate cluster costs nothing; you pay only while a task runs.

resource "aws_ecs_cluster" "transcoder" {
  name = "${local.name}-transcoder"
}

# --- Roles --------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by the ECS agent (not your code): pull the image, write logs, read secrets.
resource "aws_iam_role" "transcoder_execution" {
  name               = "${local.name}-transcoder-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "transcoder_execution" {
  role       = aws_iam_role.transcoder_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "transcoder_execution_secrets" {
  statement {
    sid       = "ReadTranscoderSecrets"
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.supabase_url.arn, aws_ssm_parameter.supabase_service_role_key.arn]
  }
}

resource "aws_iam_role_policy" "transcoder_execution_secrets" {
  name   = "${local.name}-transcoder-secrets"
  role   = aws_iam_role.transcoder_execution.id
  policy = data.aws_iam_policy_document.transcoder_execution_secrets.json
}

# Used by the container itself: read the master, write the proxy, delete leftovers.
resource "aws_iam_role" "transcoder_task" {
  name               = "${local.name}-transcoder-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "transcoder_task" {
  statement {
    sid       = "ReadMasterWriteProxy"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.videos.arn}/*"]
  }
}

resource "aws_iam_role_policy" "transcoder_task" {
  name   = "${local.name}-transcoder-s3"
  role   = aws_iam_role.transcoder_task.id
  policy = data.aws_iam_policy_document.transcoder_task.json
}

# --- Task definition ----------------------------------------------------------

resource "aws_ecs_task_definition" "transcoder" {
  family                   = "${local.name}-transcoder"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.transcoder_cpu
  memory                   = var.transcoder_memory
  execution_role_arn       = aws_iam_role.transcoder_execution.arn
  task_role_arn            = aws_iam_role.transcoder_task.arn

  # ARM64 (Graviton): ~20% cheaper than x86 for the same work, and it's what an
  # Apple Silicon Mac builds natively — no QEMU emulation to get the image out.
  # ffmpeg and x264 are well supported on aarch64.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # The master is downloaded to local disk before encoding, so this has to fit
  # the largest match plus its proxy. A 2-hour recording at the iPhone's ~15 Mbps
  # is ~13 GB, and Fargate's default is only 20 GiB.
  ephemeral_storage {
    size_in_gib = var.transcoder_disk_gib
  }

  container_definitions = jsonencode([{
    name  = "transcoder"
    image = "${aws_ecr_repository.transcoder.repository_url}:latest"
    # No command here: the web app supplies the ffmpeg arguments per task, so the
    # encoding spec has one definition (web/lib/analysisProxy.ts).
    essential = true
    environment = [
      { name = "S3_BUCKET", value = aws_s3_bucket.videos.bucket },
      { name = "AWS_DEFAULT_REGION", value = var.aws_region },
    ]
    secrets = [
      { name = "SUPABASE_URL", valueFrom = aws_ssm_parameter.supabase_url.arn },
      { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = aws_ssm_parameter.supabase_service_role_key.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.transcoder.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "task"
      }
    }
  }])
}

# --- Let the web app start tasks ----------------------------------------------

data "aws_iam_policy_document" "app_transcode" {
  statement {
    sid       = "RunTranscodeTask"
    actions   = ["ecs:RunTask"]
    resources = ["${replace(aws_ecs_task_definition.transcoder.arn, "/:\\d+$/", "")}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.transcoder.arn]
    }
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.transcoder_execution.arn, aws_iam_role.transcoder_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_user_policy" "app_transcode" {
  name   = "${local.name}-run-transcoder"
  user   = aws_iam_user.app.name
  policy = data.aws_iam_policy_document.app_transcode.json
}
