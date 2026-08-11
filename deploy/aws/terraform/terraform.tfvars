domain_name = "sandbox.ojuri.io"

# The instance clones this ref to get its compose overlay and nginx config, so
# it has to point at a ref that actually contains deploy/aws/. Switch back to
# "main" once PR #120 merges.
ojuri_ref = "deploy/aws-test-environment"

# Phi-3 for real. 32 GB is the floor: ~7.6 GB of bfloat16 weights plus KV cache
# on top of ~8 GB for the rest of the stack, and the 16 GB default would OOM the
# host rather than just the container. Drop back to t3a.xlarge with
# fia_llm_enabled = false when the LLM is not being exercised — this instance
# costs roughly twice as much per hour.
instance_type   = "m7i.2xlarge"
fia_llm_enabled = true
fia_mem_limit   = "20g"

# DNS is not in Route53, so route53_zone_id stays empty and the domain is
# attached on a second apply. Flip dns_records_created to true once the two
# records from `terraform output dns_records_to_create` resolve.
dns_records_created = false
