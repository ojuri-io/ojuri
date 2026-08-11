domain_name = "sandbox.ojuri.io"

# The instance clones this ref for its compose overlay and nginx config. It
# tracked the feature branch until deploy/aws/ existed on main.
ojuri_ref = "main"

# Phi-3 was verified on m7i.2xlarge with fia_llm_enabled = true and
# fia_mem_limit = "20g": 7.58 GB resident in bfloat16, ~135 s per report on CPU,
# llmModelVersion with no -fallback suffix. Reverted afterwards because the
# instance type outlives a stop — the wake button would otherwise restart a box
# costing twice as much with a 7.6 GB model load on boot. Set those three
# together, never the LLM flag alone: 16 GB OOMs the host, not the container.
instance_type = "t3a.xlarge"

# DNS is not in Route53, so route53_zone_id stays empty and the domain attaches
# on a second apply. Both records now resolve and ACM reports the certificate
# ISSUED, so CloudFront can take the alias.
dns_records_created = true

# The marketing site's live API demo calls this sandbox from the browser, which
# is cross-origin. RDA matches Origin exactly, so both hosts are listed.
extra_cors_origins = ["https://ojuri.io", "https://www.ojuri.io"]

# Published on ojuri.io so visitors can sign into the sandbox. Public by design.
demo_user_password = "try-ojuri"
