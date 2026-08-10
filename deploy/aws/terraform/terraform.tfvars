domain_name = "sandbox.ojuri.io"

# DNS is not in Route53, so route53_zone_id stays empty and the domain is
# attached on a second apply. Flip dns_records_created to true once the two
# records from `terraform output dns_records_to_create` resolve.
dns_records_created = false
