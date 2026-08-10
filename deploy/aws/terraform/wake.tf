data "archive_file" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.terraform-build/wake.zip"
}

resource "aws_iam_role" "wake" {
  count = var.wake_button_enabled ? 1 : 0
  name  = "${local.name}-wake"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# The whole authority of the public wake button. It can start one specific
# instance and read instance state. It cannot stop, reboot, modify, or terminate
# anything, and it cannot touch any other instance in the account — so the worst
# a hostile caller achieves is starting a box that stops itself again on the
# timers below.
resource "aws_iam_role_policy" "wake" {
  count = var.wake_button_enabled ? 1 : 0
  name  = "start-ojuri-instance"
  role  = aws_iam_role.wake[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ec2:StartInstances"
        Resource = "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.main.id}"
      },
      {
        # ec2:DescribeInstances rejects resource-level scoping, so it is bounded
        # by region instead. It is a read of instance state only.
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = var.region }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "wake_logs" {
  count      = var.wake_button_enabled ? 1 : 0
  role       = aws_iam_role.wake[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "wake" {
  count             = var.wake_button_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name}-wake"
  retention_in_days = 14
}

resource "aws_lambda_function" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  function_name    = "${local.name}-wake"
  role             = aws_iam_role.wake[0].arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.wake[0].output_path
  source_code_hash = data.archive_file.wake[0].output_base64sha256
  timeout          = 10
  memory_size      = 256

  # A hard ceiling on how much the public endpoint can ever run. Without it a
  # scripted flood would scale out to the account concurrency limit and bill for
  # every invocation.
  reserved_concurrent_executions = 5

  environment {
    variables = {
      INSTANCE_ID = aws_instance.main.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.wake]
}

# Auth is NONE because this is the front door for people who have no AWS
# credentials — that is the entire point of the button. The endpoint is safe to
# expose because the role behind it can only start one instance, concurrency is
# capped, and the instance stops itself on a timer regardless of who woke it.
resource "aws_lambda_function_url" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  function_name      = aws_lambda_function.wake[0].function_name
  authorization_type = "NONE"
}
