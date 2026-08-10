output "url" {
  description = "Front door for the Sentinel dashboard and the RDA API."
  value       = local.public_origin
}

output "dns_records_to_create" {
  description = <<-EOT
    Records to add at your DNS provider when the zone is not in Route53. The
    CNAME with the long random name proves to ACM that you control the domain
    and must stay in place — deleting it after issuance breaks renewal.
  EOT
  value = local.manage_dns || !local.use_custom_domain ? [] : concat(
    [for o in flatten(aws_acm_certificate.main[*].domain_validation_options) : {
      purpose = "certificate validation"
      type    = o.resource_record_type
      name    = o.resource_record_name
      value   = o.resource_record_value
    }],
    [{
      purpose = "point the subdomain at the environment"
      type    = "CNAME"
      name    = var.domain_name
      value   = aws_cloudfront_distribution.main.domain_name
    }],
  )
}

output "instance_id" {
  description = "EC2 instance ID, used by the Makefile targets."
  value       = aws_instance.main.id
}

output "region" {
  description = "Region everything was created in."
  value       = var.region
}

output "shell_command" {
  description = "Open a shell on the instance. No SSH key and no open port involved."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.main.id}"
}

output "grafana_tunnel_command" {
  description = <<-EOT
    Grafana and Prometheus are bound to the instance's loopback and are not
    routable from the internet. Forward a local port over SSM to reach them.
  EOT
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.main.id} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"3001\"],\"localPortNumber\":[\"3001\"]}'"
}

output "grafana_password" {
  description = "Grafana admin password. Also readable from SSM at any time."
  value       = random_password.grafana.result
  sensitive   = true
}

output "admin_password" {
  description = <<-EOT
    Bootstrap password for the Sentinel `admin` user. The account is created
    with mustChangePassword=true, so the first login forces a rotation and this
    value stops working.
  EOT
  value       = random_password.admin_seed.result
  sensitive   = true
}
