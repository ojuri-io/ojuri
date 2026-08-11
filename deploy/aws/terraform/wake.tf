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

  # A ceiling on how much the public endpoint can ever run, so a scripted flood
  # cannot scale out and bill for every invocation. Left unset by default: a new
  # account's total concurrency limit is 10, and AWS rejects any reservation that
  # would push unreserved concurrency below 10 — so on such an account this
  # cannot be set at all, and the account limit is itself the ceiling. Set it
  # once you have raised the account limit, at which point the account no longer
  # bounds this function.
  reserved_concurrent_executions = var.wake_reserved_concurrency

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
# A Lambda Function URL would be the simpler choice and was the original design,
# but this account returns AccessDeniedException on anonymous invocation even
# with AuthType NONE and a public resource policy on the function. API Gateway
# reaches the function as the apigateway service principal instead of as an
# anonymous caller, so it does not depend on public invoke being permitted.
resource "aws_apigatewayv2_api" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  name          = "${local.name}-wake"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.wake[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.wake[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.wake[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.wake[0].id}"
}

# $default stage serves paths verbatim, with no stage prefix to strip, so
# /_wake/status arrives at the handler exactly as CloudFront sent it.
resource "aws_apigatewayv2_stage" "wake" {
  count = var.wake_button_enabled ? 1 : 0

  api_id      = aws_apigatewayv2_api.wake[0].id
  name        = "$default"
  auto_deploy = true
}

# Nothing invokes the function without this: API Gateway calls Lambda under its
# own service principal, and an integration pointing at a function it may not
# invoke fails as a bare 500 with no log line, because the invocation never
# happens. source_arn keeps the grant to this one API rather than to API Gateway
# in general.
resource "aws_lambda_permission" "wake_apigw" {
  count = var.wake_button_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.wake[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.wake[0].execution_arn}/*/*"
}
