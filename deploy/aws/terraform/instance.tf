data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
}

resource "aws_iam_role" "instance" {
  name = "${local.name}-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Session Manager. This is the only shell path onto the box, which is why there
# is no key pair anywhere in this configuration and no port 22 in the security
# group.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Read access is scoped to this environment's parameters. The instance cannot
# enumerate or read secrets belonging to any other Ojuri environment in the
# account, and it holds no write permission on its own secrets.
resource "aws_iam_role_policy" "read_secrets" {
  name = "read-ojuri-secrets"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "arn:aws:kms:${var.region}:${data.aws_caller_identity.current.account_id}:key/*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

data "aws_caller_identity" "current" {}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "main" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = true

  # `shutdown -h now` from the idle and nightly timers stops the instance
  # instead of terminating it, so the box needs no ec2:StopInstances permission
  # of its own and the root volume survives.
  instance_initiated_shutdown_behavior = "stop"

  # IMDSv2 only, with a hop limit of 1. The hop limit is the important half:
  # Docker's bridge adds a hop, so no container on this host can reach the
  # metadata service and mint credentials from the instance role. An SSRF in
  # RDA, PAA, or the Sentinel bundle cannot escalate to the AWS account.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size
    encrypted             = true
    delete_on_termination = true
  }

  # The front-door URL is deliberately absent here. CloudFront's origin is this
  # instance, so referencing its domain from user-data would be a dependency
  # cycle; the bootstrap reads PUBLIC_ORIGIN from SSM at every boot instead.
  user_data = templatefile("${path.module}/../scripts/bootstrap.sh.tftpl", {
    region            = var.region
    ssm_prefix        = local.ssm_prefix
    ojuri_ref         = var.ojuri_ref
    ojuri_version     = var.ojuri_version
    idle_stop_minutes = var.idle_stop_minutes
    nightly_stop_utc  = var.nightly_stop_utc
  })

  # Editing the bootstrap script alone will not rebuild a running box; cloud-init
  # runs once per instance. Re-run it by hand over SSM, or taint the instance.
  user_data_replace_on_change = false

  tags = { Name = local.name }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "main" {
  domain   = "vpc"
  instance = aws_instance.main.id

  tags = { Name = local.name }
}
