locals {
  name = "ojuri-${var.environment}"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# The instance sits in a public subnet with a tightly scoped security group
# rather than a private subnet behind NAT. A NAT gateway costs more per month
# than the instance it would be fronting, and buys little here: nothing can
# reach the box except CloudFront, and there is no inbound path to the shell at
# all. See README "Why the instance is in a public subnet".
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Leaving the VPC's default security group with rules attached is a standing
# invitation; strip it so anything accidentally launched into this VPC without
# an explicit group is isolated.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "instance" {
  name        = "${local.name}-instance"
  description = "Ojuri test instance: CloudFront-only ingress, no shell port"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-instance" }
}

# Port 80 is reachable only from CloudFront's published origin ranges. There is
# deliberately no port 22 rule: shell access is SSM Session Manager, which dials
# out from the instance and needs no listening port and no key material.
resource "aws_vpc_security_group_ingress_rule" "from_cloudfront" {
  security_group_id = aws_security_group.instance.id
  description       = "HTTP from CloudFront edge only"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.instance.id
  description       = "Outbound for image pulls, SSM, and package updates"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_flow_log" "vpc" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  iam_role_arn         = aws_iam_role.flow_logs.arn
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  log_destination_type = "cloud-watch-logs"
}

# Rejected traffic only. Accepted traffic on a box whose only ingress is
# CloudFront tells you nothing you did not already know, and logging it turns a
# quiet test environment into a real CloudWatch bill.
resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/ojuri/${var.environment}/vpc-flow-logs"
  retention_in_days = 7
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-flow-logs"
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}
