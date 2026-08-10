# Ojuri on AWS — test environment

One EC2 instance running the whole Ojuri stack, behind CloudFront with HTTPS.
It stops itself when nobody is using it and can be woken from a button on the
page, so it costs roughly **$35/month** instead of the ~$117 it would cost
running continuously.

You do not need to be a DevOps engineer to run this. There are three commands.

---

## What you get

| | |
|---|---|
| **Sentinel dashboard** | `https://<your-url>/` |
| **RDA prediction API** | `https://<your-url>/v1/predict` |
| **FIA investigation API** | `https://<your-url>/fia/v1/reports` |
| **MLA drift + retrain** | `https://<your-url>/mla/v1/admin/...` |
| **Grafana / Prometheus** | not public — reached through a tunnel, see below |

Everything runs on one instance: RDA (1 replica), PAA, MLA, FIA, Postgres,
Redis, Kafka, Zookeeper, Prometheus, Grafana, and nginx.

---

## Before you start

Install the two tools and log in to AWS:

```bash
brew install awscli terraform     # macOS; see the tools' docs for Linux/Windows
aws configure                     # or: aws sso login
```

Check it worked:

```bash
aws sts get-caller-identity
```

If that prints your account ID, you are ready.

---

## Deploy it

```bash
cd deploy/aws
make init
make deploy
```

Terraform will show you what it is about to create and wait for you to type
`yes`. First run takes about 10 minutes, most of it CloudFront propagating.

When it finishes:

```bash
make url        # the HTTPS address
make secrets    # the admin login
```

Open the URL, sign in as `admin` with the password `make secrets` printed, and
Sentinel will immediately ask you to choose a new one.

That is the whole deployment. You did not create a domain, request a
certificate, generate a password, or open a firewall port, because none of that
is left to you.

---

## Putting it on your own subdomain (optional)

By default the environment is served on an AWS-provided
`something.cloudfront.net` address that already has a valid certificate and
needs no DNS work. To use your own hostname instead:

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

### If your DNS is in Route53

Set `domain_name` and `route53_zone_id`, then `make deploy`. The certificate is
requested, validated, renewed and wired up in one pass.

### If your DNS is anywhere else (Cloudflare, Namecheap, …)

AWS cannot write the records for you, and CloudFront will not accept the
hostname until the certificate is *issued* — which needs one of those records
in place first. So it takes two applies.

**Step 1.** Set `domain_name = "sandbox.yourdomain.com"`, leave `route53_zone_id`
empty and `dns_records_created = false`, then:

```bash
make deploy
terraform -chdir=terraform output dns_records_to_create
```

That prints two records. Add both at your DNS provider:

| Purpose | Type | Name | Value |
|---|---|---|---|
| Certificate validation | CNAME | `_a1b2c3….sandbox.yourdomain.com` | `_x9y8z7….acm-validations.aws` |
| The subdomain itself | CNAME | `sandbox.yourdomain.com` | `d1234abcd.cloudfront.net` |

**Step 2.** Once they resolve — check with `dig sandbox.yourdomain.com` — set
`dns_records_created = true` and run `make deploy` again. ACM validates in a
minute or two and the hostname goes live.

Two things worth knowing:

- **Leave the validation CNAME in place forever.** ACM re-checks it to renew the
  certificate automatically. Deleting it after issuance means the certificate
  expires roughly a year later and the site goes dark with no warning.
- **On Cloudflare, keep the record DNS-only (grey cloud).** Proxying it puts
  Cloudflare in front of CloudFront, which terminates TLS twice for no benefit
  and replaces the viewer's IP with Cloudflare's — the nginx rate limit keys on
  `X-Forwarded-For`, so every visitor would share one bucket.

---

## Day to day

```bash
make status     # running or stopped
make up         # start it
make down       # stop it now
make url        # print the address
make shell      # get a shell on the box
make logs       # tail the stack logs
make grafana    # open Grafana at http://localhost:3001
make secrets    # print the generated passwords
make destroy    # delete everything
```

### When it is asleep

Visiting the URL shows a page saying the demo is asleep, with a **Wake it up**
button. Anyone can press it — no AWS account needed. Waking takes about three
minutes, because the stack has to start Kafka and Postgres, run database
migrations, and only then start RDA and PAA. The page polls and redirects itself
when the stack answers.

`make up` does exactly the same thing from your terminal.

### When it goes to sleep

- **After 60 minutes with no traffic.** Adjustable with `idle_stop_minutes`.
- **Every night at 22:00 UTC**, no matter what. Adjustable with
  `nightly_stop_utc`.

The nightly stop is deliberate belt-and-braces: it is the ceiling on what a
single day can cost if idle detection fails or someone leaves a tab open
refreshing.

---

## What this costs

| | Monthly |
|---|---|
| `t3a.xlarge`, ~8 h/day | ~$26 |
| 60 GB gp3 storage | ~$5 |
| Elastic IP | ~$3.60 |
| CloudFront + Lambda + logs | under $1 |
| **Total** | **~$35** |

Storage and the IP address are billed whether the instance runs or not — that
is what preserves your data and keeps the URL stable while it sleeps. Compute
is billed only while it is running. Figures are approximate and vary by region;
check the AWS pricing calculator for yours.

---

## How this is kept secure

Each of these is a deliberate choice, not a default.

**Nothing can reach the instance except CloudFront.** The security group admits
port 80 from CloudFront's published address ranges and nothing else. There is no
rule for any other port, from any other source.

**There is no SSH.** No port 22, no key pair, no private key for anyone to lose.
Shell access is AWS Systems Manager, which dials *out* from the instance. Access
is controlled by IAM, so revoking someone's AWS access revokes their shell.

**Databases are not listening on a public address.** Postgres, Redis, Kafka,
Prometheus and Grafana bind to the instance's loopback interface. Even if the
security group were later opened by mistake, there is nothing listening on a
routable address to reach.

**A container that gets compromised cannot reach AWS.** The metadata service
requires IMDSv2 and is limited to one network hop. Docker's bridge is a hop, so
no container can request credentials from the instance role — an SSRF bug in RDA
or the dashboard cannot become an AWS account compromise.

**No password is written by a human or stored in this repository.** Terraform
generates them and puts them in SSM Parameter Store, encrypted. The instance
reads them at boot through its IAM role, scoped to this environment's parameters
only. They are never in the repo, never in a tfvars file, and never in the
instance's user-data, which any process on the box could otherwise read back.

**The admin account cannot be claimed by whoever finds the URL first.** The seed
password is generated ahead of time and stored in SSM, and the account is
created with `mustChangePassword`, so the first login must rotate it.

**The predict API requires a key.** `RDA_REQUIRE_API_KEY=true`, so the scoring
endpoint is not open to the internet.

**The public wake button cannot do anything else.** The Lambda behind it may
start one specific instance and read its state. It holds no permission to stop,
reboot, modify, or terminate anything, and none at all over any other instance.
Its concurrency is capped at 5, and the instance stops itself on a timer no
matter who woke it.

**The box patches itself.** `dnf-automatic` applies security updates, which
matters for a machine that may sleep for weeks between uses.

**TLS is managed by AWS.** The certificate lives on CloudFront and renews
automatically. A certificate on the instance would expire while it was stopped —
renewal needs the machine running.

**Rejected network traffic is logged** to CloudWatch with 7-day retention.
Accepted traffic is not: on a box whose only ingress is CloudFront it would tell
you nothing and cost real money.

### Why the instance is in a public subnet

A private subnet is the textbook answer, and it needs a NAT gateway to reach
GHCR and SSM — about $32/month, roughly the entire budget for this environment,
to protect a box that already admits nothing but CloudFront and has no inbound
shell path. VPC interface endpoints are cheaper but still add ~$21/month.

The trade is stated rather than hidden. If this environment ever holds real
data, move it to a private subnet with endpoints — the security group and IAM
work is already done.

### What is deliberately not here

- **No WAF.** ~$8/month plus per-request charges, more than the instance it
  would protect. Worth adding if the URL is ever shared widely.
- **No CloudFront access logs.** Requires an S3 bucket with ACLs enabled, which
  fights modern S3 defaults. The nginx logs on the instance cover debugging.
- **No backups.** This is a test environment; `make destroy` and redeploy is the
  recovery plan. Add EBS snapshots before putting anything you care about here.
- **No multi-AZ, no autoscaling.** One instance, by design.

---

## Reaching Grafana and Prometheus

They are not on the internet. Forward a port over SSM instead:

```bash
make grafana
```

Then open `http://localhost:3001`. Log in with `admin` and the Grafana password
from `make secrets`.

---

## Testing FIA with the real LLM

By default FIA runs with `FIA_DISABLE_LLM=true` and produces deterministic
rule-based reports. This is not a downgrade for most testing: the Kafka
consumer, the per-partition offset commits, the idempotency guard and the HTTP
API all run exactly as they do in production. What you do not get is Phi-3's
narrative text.

Phi-3-mini needs ~15 GB resident in fp32 on CPU, which does not fit alongside
the rest of the stack on a 16 GB instance. To test it for real, move to a GPU
instance for the session:

```bash
make down
# set instance_type = "g4dn.2xlarge" in terraform.tfvars
make deploy
make up
```

Then set `FIA_DISABLE_LLM=false` and restart FIA. Both instance families are
Nitro, so the same disk boots on either — no rebuild, no data migration. Switch
back the same way when you are done; a GPU instance is roughly $0.75/hour.

**Two things to fix before you do this.** The GPU path does not work as shipped:

1. `fia-service/src/llm/phi3_generator.py` requests
   `attn_implementation="flash_attention_2"` whenever CUDA is present, but
   `flash-attn` is not in `fia-service/requirements.txt`. The load raises,
   `FIA_FALLBACK_ON_LLM_FAILURE` catches it, and FIA quietly serves rule-based
   reports — the exact thing the GPU was rented to avoid. Check `llm_model` on
   `/fia/stats`: a value ending in `-fallback` means this happened.
2. The `fia` service has no GPU passthrough in `docker-compose.yml`, and the
   host needs `nvidia-container-toolkit`.

---

## If something goes wrong

**The URL shows the wake page but pressing the button does nothing.**
Check `make status`. If it says `running`, the instance is up but the stack is
not answering yet — give it three minutes. `make logs` shows what it is doing.

**It says running but the page will not load.**
The stack is probably still starting. `db-migrate` must finish before RDA
starts, and Kafka's health check gates everything.

```bash
make shell
sudo journalctl -u ojuri -f          # what the boot did
cd /opt/ojuri && docker compose ps    # what is up
```

**First boot did not finish.**
Cloud-init runs once and logs everything:

```bash
make shell
sudo cat /var/log/ojuri-bootstrap.log
```

**I changed the bootstrap script and nothing happened.**
Cloud-init runs once per instance, so editing it does not affect a running box.
Either re-run the pieces by hand over `make shell`, or `terraform taint` the
instance and redeploy.

**I want to start over.**
`make destroy`, then `make deploy`. Everything is reproducible; nothing is kept.

---

## Layout

```
deploy/aws/
  Makefile                        every command you need
  README.md                       this file
  terraform/
    variables.tf                  everything you can tune
    network.tf                    VPC, subnet, security group, flow logs
    instance.tf                   EC2, IAM role, Elastic IP
    secrets.tf                    generated passwords -> SSM
    cloudfront.tf                 TLS front door, optional custom domain
    wake.tf                       the wake button's Lambda and permissions
    lambda/index.mjs              the wake page itself
  scripts/
    bootstrap.sh.tftpl            first boot, and the per-boot systemd units
  compose/
    docker-compose.ec2.yml        1 replica, loopback ports, memory limits
  nginx/
    nginx.conf                    routes Sentinel at /, RDA at /v1/
```

State is kept in `terraform/terraform.tfstate` on your machine and is
gitignored — **it contains every generated password in plaintext.** If more than
one person will run `make deploy`, move it to an S3 backend with DynamoDB
locking first.
