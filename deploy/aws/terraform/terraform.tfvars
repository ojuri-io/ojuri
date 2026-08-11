domain_name = "sandbox.ojuri.io"

# The instance clones this ref to get its compose overlay and nginx config, so
# it has to point at a ref that actually contains deploy/aws/. Switch back to
# "main" once PR #120 merges.
ojuri_ref = "deploy/aws-test-environment"

# Phi-3 was verified on m7i.2xlarge with fia_llm_enabled = true and
# fia_mem_limit = "20g": 7.58 GB resident in bfloat16, ~135 s per report on CPU,
# llmModelVersion with no -fallback suffix. Reverted afterwards because the
# instance type outlives a stop — the wake button would otherwise restart a box
# costing twice as much with a 7.6 GB model load on boot. Set those three
# together, never the LLM flag alone: 16 GB OOMs the host, not the container.
instance_type = "t3a.xlarge"

# DNS is not in Route53, so route53_zone_id stays empty and the domain is
# attached on a second apply. Flip dns_records_created to true once the two
# records from `terraform output dns_records_to_create` resolve.
dns_records_created = false
