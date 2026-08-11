domain_name = "sandbox.ojuri.io"

# The instance clones this ref to get its compose overlay and nginx config, so
# it has to point at a ref that actually contains deploy/aws/. Switch back to
# "main" once PR #120 merges.
ojuri_ref = "deploy/aws-test-environment"

# DNS is not in Route53, so route53_zone_id stays empty and the domain is
# attached on a second apply. Flip dns_records_created to true once the two
# records from `terraform output dns_records_to_create` resolve.
dns_records_created = false
