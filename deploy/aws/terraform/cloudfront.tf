locals {
  use_custom_domain = var.domain_name != ""
  manage_dns        = var.domain_name != "" && var.route53_zone_id != ""

  # CloudFront will only accept the alias once ACM has *issued* the certificate,
  # and ACM only issues once the validation record resolves. With Route53 that
  # is one pass, because Terraform writes the record itself. With DNS anywhere
  # else it takes two applies, with you adding the records in between — hence
  # the dns_records_created flag rather than an apply that blocks for an hour
  # waiting on a record nobody has been shown yet.
  attach_domain = local.use_custom_domain && (local.manage_dns || var.dns_records_created)
  public_origin = local.attach_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# The wake Lambda sits behind a Function URL, which routes on the Host header it
# receives. Forwarding the viewer's Host would send it the CloudFront domain and
# produce a 403.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_acm_certificate" "main" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  # Splat rather than [0]: this expression is evaluated even when no certificate
  # exists, and indexing a zero-length resource is an error rather than a null.
  for_each = {
    for o in flatten(aws_acm_certificate.main[*].domain_validation_options) :
    o.domain_name => {
      name   = o.resource_record_name
      record = o.resource_record_value
      type   = o.resource_record_type
    } if local.manage_dns
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

# With DNS elsewhere there are no record resources to wait on, so this just
# polls until ACM reports the certificate issued.
resource "aws_acm_certificate_validation" "main" {
  count    = local.attach_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = local.manage_dns ? [for r in aws_route53_record.cert_validation : r.fqdn] : null

  timeouts {
    create = "20m"
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "Ojuri ${var.environment} front door"
  aliases         = local.attach_domain ? [var.domain_name] : []
  price_class     = "PriceClass_100"
  is_ipv6_enabled = true

  # TLS terminates here with an AWS-managed certificate that renews itself. That
  # is what lets the instance sleep for weeks: a certbot certificate on the box
  # would expire while it was stopped, and renewal needs the box up.
  origin {
    origin_id   = "ec2"
    domain_name = aws_eip.main.public_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }

  dynamic "origin" {
    for_each = var.wake_button_enabled ? [1] : []

    content {
      origin_id   = "wake"
      domain_name = replace(aws_apigatewayv2_api.wake[0].api_endpoint, "https://", "")

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # Nothing is cached. This fronts a live API and an operator dashboard whose
  # reads are authorization-sensitive; a shared edge cache in front of either is
  # a data-leak waiting to happen, and a test environment gains nothing from it.
  default_cache_behavior {
    target_origin_id           = "ec2"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.wake_button_enabled ? [1] : []

    content {
      path_pattern             = "/_wake*"
      target_origin_id         = "wake"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    }
  }

  # When the instance is stopped the origin refuses the connection and CloudFront
  # produces a 502/504. Rewriting that to the wake page is what turns "this site
  # is broken" into a button. TTL 0 so the page stops being served the instant
  # the box answers again.
  dynamic "custom_error_response" {
    for_each = var.wake_button_enabled ? toset([502, 503, 504]) : toset([])

    content {
      error_code = custom_error_response.value
      # 503, not 200. The wake page polls `HEAD /` to decide when the stack is
      # answering, and rewriting the dead origin's 502 to a 200 would tell it the
      # box was up while it was still booting — it would bounce the visitor
      # straight back to this same page.
      response_code         = 503
      response_page_path    = "/_wake/down"
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.attach_domain
    acm_certificate_arn            = one(aws_acm_certificate_validation.main[*].certificate_arn)
    ssl_support_method             = local.attach_domain ? "sni-only" : null
    minimum_protocol_version       = local.attach_domain ? "TLSv1.2_2021" : null
  }
}

resource "aws_route53_record" "main" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# Read by the instance at every boot to set SENTINEL_CORS_ORIGINS. Passing it
# through SSM rather than user-data is what breaks the instance -> CloudFront ->
# EIP -> instance dependency cycle.
resource "aws_ssm_parameter" "public_origin" {
  name  = "${local.ssm_prefix}/PUBLIC_ORIGIN"
  type  = "String"
  value = local.public_origin
}

# Read at every boot alongside PUBLIC_ORIGIN, so flipping the LLM on or off is a
# variable change and a restart rather than a rebuilt instance — cloud-init runs
# once, and user-data edits do not reach a box that is already running.
resource "aws_ssm_parameter" "fia_runtime" {
  name = "${local.ssm_prefix}/FIA_RUNTIME"
  type = "String"
  value = jsonencode({
    disable_llm = var.fia_llm_enabled ? "false" : "true"
    mem_limit   = var.fia_mem_limit
  })
}
