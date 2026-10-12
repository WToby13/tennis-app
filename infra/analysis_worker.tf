# --- Our own match analysis worker (AWS Batch on GPU spot) ---------------------
#
# Replaces TwelveLabs once ANALYSIS_ENGINE=own (web/lib/ojoEngine.ts). When an
# owner asks for a breakdown the app queues the match and submits one Batch job;
# the job starts a GPU instance, runs `python -m ojo_replay.worker --once`
# (ml/docker/), which claims the match from the app, analyses it, posts the
# result and exits. With nothing queued the compute environment scales to zero,
# so idle costs nothing.
#
# GPU: g6.xlarge (one NVIDIA L4, 4 vCPU, 16 GB) on spot, ~$0.30-0.45/h in
# eu-west-1 against ~$0.98 on demand. A 1-hour match is roughly 20-30 GPU
# minutes (estimate until benchmarked; see docs/OWN_ANALYSIS_LAUNCH.md).
#
# Same network stance as the transcoder: default VPC, public subnets with a
# public IP (no NAT gateway to pay for), and a security group with no inbound.

resource "aws_security_group" "analysis_worker" {
  name        = "${local.name}-analysis-worker"
  description = "Outbound only; the analysis worker accepts no inbound connections."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound (the app, S3/CloudFront, ECR, CloudWatch)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Image registry -----------------------------------------------------------

resource "aws_ecr_repository" "analysis_worker" {
  name                 = "${local.name}-analysis-worker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "analysis_worker" {
  repository = aws_ecr_repository.analysis_worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 5 most recent images."
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# --- Secrets ------------------------------------------------------------------

resource "aws_ssm_parameter" "worker_app_url" {
  name  = "/${local.name}/analysis-worker/app_url"
  type  = "String"
  value = var.worker_app_url
}

resource "aws_ssm_parameter" "worker_secret" {
  name  = "/${local.name}/analysis-worker/secret"
  type  = "SecureString"
  value = var.analysis_worker_secret
}

resource "aws_cloudwatch_log_group" "analysis_worker" {
  name              = "/aws/batch/${local.name}-analysis-worker"
  retention_in_days = 30
}

# --- IAM ----------------------------------------------------------------------

data "aws_iam_policy_document" "batch_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["batch.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "batch_service" {
  name               = "${local.name}-batch-service"
  assume_role_policy = data.aws_iam_policy_document.batch_assume.json
}

resource "aws_iam_role_policy_attachment" "batch_service" {
  role       = aws_iam_role.batch_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# The GPU instances themselves: join ECS, pull from ECR, write logs.
resource "aws_iam_role" "analysis_instance" {
  name               = "${local.name}-analysis-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "analysis_instance" {
  role       = aws_iam_role.analysis_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "analysis_instance" {
  name = "${local.name}-analysis-instance"
  role = aws_iam_role.analysis_instance.name
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Reads the two SSM parameters into the container's environment.
resource "aws_iam_role" "analysis_execution" {
  name               = "${local.name}-analysis-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "analysis_execution" {
  role       = aws_iam_role.analysis_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "analysis_execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.worker_app_url.arn, aws_ssm_parameter.worker_secret.arn]
  }
}

resource "aws_iam_role_policy" "analysis_execution_secrets" {
  name   = "read-worker-secrets"
  role   = aws_iam_role.analysis_execution.id
  policy = data.aws_iam_policy_document.analysis_execution_secrets.json
}

# --- Batch --------------------------------------------------------------------

resource "aws_batch_compute_environment" "analysis" {
  compute_environment_name = "${local.name}-analysis-gpu"
  type                     = "MANAGED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type                = "SPOT"
    allocation_strategy = "SPOT_PRICE_CAPACITY_OPTIMIZED"
    instance_type       = var.worker_instance_types
    min_vcpus           = 0
    max_vcpus           = var.worker_max_vcpus
    instance_role       = aws_iam_instance_profile.analysis_instance.arn
    subnets             = data.aws_subnets.default.ids
    security_group_ids  = [aws_security_group.analysis_worker.id]

    # The ECS GPU-optimized AMI (NVIDIA driver and container toolkit included).
    ec2_configuration {
      image_type = "ECS_AL2_NVIDIA"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.batch_service]
}

resource "aws_batch_job_queue" "analysis" {
  name     = "${local.name}-analysis"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.analysis.arn
  }
}

resource "aws_batch_job_definition" "analysis" {
  name = "${local.name}-analysis"
  type = "container"

  # A spot instance can be reclaimed mid-match; the job just runs again (the
  # app hands an unfinished claim to a worker again after a while).
  retry_strategy {
    attempts = 2
  }
  timeout {
    attempt_duration_seconds = 4 * 60 * 60
  }

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.analysis_worker.repository_url}:latest"
    command          = ["python", "-m", "ojo_replay.worker", "--once"]
    executionRoleArn = aws_iam_role.analysis_execution.arn
    resourceRequirements = [
      { type = "VCPU", value = "4" },
      { type = "MEMORY", value = "14000" },
      { type = "GPU", value = "1" },
    ]
    secrets = [
      { name = "OJO_APP_URL", valueFrom = aws_ssm_parameter.worker_app_url.arn },
      { name = "ANALYSIS_WORKER_SECRET", valueFrom = aws_ssm_parameter.worker_secret.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.analysis_worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  })
}

# The web app submits one job per queued match.
data "aws_iam_policy_document" "app_submit_analysis" {
  statement {
    actions   = ["batch:SubmitJob"]
    resources = [aws_batch_job_queue.analysis.arn, "${replace(aws_batch_job_definition.analysis.arn, "/:\\d+$/", "")}:*"]
  }
}

resource "aws_iam_user_policy" "app_submit_analysis" {
  name   = "submit-analysis-jobs"
  user   = aws_iam_user.app.name
  policy = data.aws_iam_policy_document.app_submit_analysis.json
}
