variable "region" {
  description = "AWS region for the test environment."
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment name; used in resource names and tags."
  type        = string
  default     = "test"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. t3a.xlarge (4 vCPU / 16 GB) runs the whole stack with
    RDA_REPLICAS=1 and FIA_DISABLE_LLM=true. Switch to g4dn.2xlarge to test FIA
    against the real Phi-3 model: stop the instance, re-apply with the new type,
    start it again. Both families are Nitro, so the same root volume boots on
    either without a rebuild.
  EOT
  type        = string
  default     = "t3a.xlarge"
}

variable "root_volume_size" {
  description = <<-EOT
    Root volume size in GiB. 60 is enough with FIA_DISABLE_LLM=true; add ~10 if
    you ever cache the Phi-3 weights on this box.
  EOT
  type        = number
  default     = 60
}

variable "ojuri_ref" {
  description = "Git ref of ojuri-io/ojuri to check out on the instance."
  type        = string
  default     = "main"
}

variable "ojuri_version" {
  description = <<-EOT
    OJURI_VERSION passed to docker-compose.ghcr.yml. Defaults to the floating
    major so the box picks up patches; pin to an exact vX.Y.Z for a stable demo.
  EOT
  type        = string
  default     = "v1"
}

variable "domain_name" {
  description = <<-EOT
    Optional custom hostname (e.g. "ojuri-test.example.com"). Leave empty to use
    the CloudFront-provided *.cloudfront.net domain, which already carries a
    valid certificate and needs no DNS setup at all.
  EOT
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = <<-EOT
    Route53 hosted zone ID owning domain_name. Set it and DNS is handled for you
    in a single apply. Leave it empty when DNS lives anywhere else (Cloudflare,
    Namecheap, ...) and follow the two-step flow described in the README.
  EOT
  type        = string
  default     = ""
}

variable "dns_records_created" {
  description = <<-EOT
    Only relevant when DNS is not in Route53. Leave false for the first apply,
    which creates the certificate and prints the records to add. Set true once
    those records resolve, and the second apply attaches the domain.
  EOT
  type        = bool
  default     = false
}

variable "idle_stop_minutes" {
  description = <<-EOT
    Shut the instance down after this many minutes with no request reaching
    nginx. Set to 0 to disable idle shutdown.
  EOT
  type        = number
  default     = 60
}

variable "nightly_stop_utc" {
  description = <<-EOT
    Unconditional daily shutdown time, HH:MM in UTC. This is the backstop that
    bounds cost if idle detection fails or someone holds the box awake through
    the public wake button. Set to "" to disable.
  EOT
  type        = string
  default     = "22:00"
}

variable "fia_llm_enabled" {
  description = <<-EOT
    Load the real Phi-3 model in FIA instead of the deterministic rule-based
    path. Needs an instance with at least 32 GB: the weights alone are ~7.6 GB
    in bfloat16 and ~15 GB in fp32, on top of ~8 GB for the rest of the stack.
    Leave false on the default t3a.xlarge or the box will OOM.
  EOT
  type        = bool
  default     = false
}

variable "fia_mem_limit" {
  description = "Memory ceiling for the FIA container. Raise it alongside fia_llm_enabled."
  type        = string
  default     = "1536m"
}

variable "wake_reserved_concurrency" {
  description = <<-EOT
    Concurrency reserved for the wake Lambda. -1 leaves it unreserved, which is
    the only workable value on an account still at the default limit of 10 total
    concurrent executions — AWS rejects any reservation that drops unreserved
    concurrency below 10. Set a small number (5 is plenty) after raising the
    account limit, since the account ceiling stops bounding the function then.
  EOT
  type        = number
  default     = -1
}

variable "wake_button_enabled" {
  description = <<-EOT
    Serve a public "wake this demo" page when the instance is stopped. The
    Lambda behind it can only describe and start this one instance — it holds no
    permission to stop, modify, or terminate anything.
  EOT
  type        = bool
  default     = true
}
