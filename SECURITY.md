# Security Policy

Ojuri is a fraud detection platform that sits on the authorization path for real money movement. We take vulnerability reports seriously and want to make them easy to file.

## Reporting a vulnerability

**Do not report security issues in public GitHub Issues, Discussions, or pull requests.** Public disclosure before a fix is available puts every adopter at risk.

Use one of the following private channels, in order of preference:

1. **GitHub Security Advisories (preferred).** Open a draft advisory at <https://github.com/ojuri-io/ojuri/security/advisories/new>. This gives us a private workspace, an audit trail, and a path to a coordinated CVE.
2. **Email.** Send a report to `security@ojuri.io`. <!-- PLACEHOLDER: maintainer to wire this mailbox once the ojuri.io domain is configured. Until then, prefer the GitHub Security Advisory channel above. -->

Please include, where you can:

- A description of the issue and the impact you believe it has.
- The affected component (RDA, PAA, MLA, FIA, Sentinel frontend, infrastructure config).
- Reproduction steps or a proof-of-concept.
- The version or commit you tested against.
- Any mitigations you have already identified.

We will acknowledge your report and keep you in the loop through to disclosure.

## What we consider a security issue

The non-exhaustive list below reflects the attack surface that matters most for a fraud detection product. Treat anything in this neighbourhood as worth reporting.

- **Authentication and authorization bypass** on `/v1/predict`, the FIA HTTP API, or any `/v1/admin/*` route. Privilege escalation between roles. JWT verification flaws, API-key verification flaws, or session-fixation issues.
- **Injection attacks** — SQL injection, command injection, SSRF, XXE, unsafe deserialization, or template injection in any service.
- **Cross-tenant data leakage** in deployments using `tenantId` to partition API keys, audit rows, or model versions.
- **HMAC signature forgery or replay** on the webhook delivery scheme (`X-Webhook-Signature`). See [`docs/WEBHOOKS.md`](docs/WEBHOOKS.md) for the current verification model.
- **Prompt injection in FIA** that causes the Phi-3 LLM to leak prompt context, ignore the JSON schema guardrails, exfiltrate transaction data into the narrative field, or produce reports that systematically mislead reviewers. The LLM runs on blocked transactions whose attacker-controlled fields (sender / receiver / amount / segment metadata) flow into the prompt — prompt-injection issues against this surface are in scope.
- **API-key or secret extraction** — flaws that let an attacker recover a raw `fdk_…` token from logs, error messages, audit rows, or in-memory state. Flaws that let an attacker recover a webhook secret beyond what is already documented as a known trade-off in `docs/WEBHOOKS.md`.
- **Cryptographic flaws** — timing-attackable comparisons of secrets or HMACs, weak randomness in token issuance, missing or incorrect HMAC verification, weak password hashing parameters.
- **Decision-path integrity** — any way to manipulate the rules engine, the model registry, the per-segment thresholds, or the reason-code output to force an arbitrary `ACCEPT` / `DECLINE` decision without going through the documented admin permissions.
- **Audit-log tampering** — anything that lets a caller write to `decisionAuditLog` with forged reviewer fields, or that lets a malicious request produce no audit row at all.
- **Container escape, privilege escalation, or supply-chain issues** in the published Docker images or the dependency graph.

## What we do not consider a security issue

- Missing security headers on the Sentinel dashboard. The dashboard is operator-facing and expected to sit behind your own ingress / SSO; ship the headers you need there. We are happy to take PRs that harden defaults, but the absence of a header is not a vulnerability against Ojuri itself.
- Self-XSS inside operator-only routes that require an authenticated session.
- Theoretical issues without a working proof-of-concept or a concrete attack path.
- Reports against dependencies that do not affect Ojuri's attack surface (e.g. a CVE in a transitive dev-time tool that is never executed in production paths).
- Best-practice / hardening suggestions with no exploitable issue. Open a normal GitHub Issue or PR for these.
- Behaviour that is documented as a deliberate trade-off. The webhook-secret storage scheme in `docs/WEBHOOKS.md` is one such known item — we will accept a PR to envelope-encrypt the raw secret, but we will not treat the current behaviour as a vulnerability against the documented threat model.

## Response timeline

Realistic commitments for a small project:

- **Acknowledgement** within **72 hours** of the report landing in the advisory queue or the security mailbox.
- **Initial triage and severity assessment** within **7 days**, communicated back to the reporter.
- **Coordinated disclosure** on a CVSS-aligned timeline — typically **30 days** for high/critical issues, **90 days** for medium and low. We will negotiate extensions in writing if a fix requires coordinated upgrades by adopters.
- **Pre-disclosure notice to known production adopters** where we have a contact path, before the advisory goes public.

If the timeline above does not match the severity you are seeing, say so in the report and we will reprioritise.

## Coordinated disclosure

We ask reporters not to publicly disclose details of a vulnerability until a fix has shipped and adopters have had a reasonable window to upgrade. In return, we will:

- Keep the reporter in the loop through triage, fix, and release.
- Credit the reporter in the release notes and the published advisory unless they ask to remain anonymous.
- Not pursue legal action against good-faith researchers who follow this policy.

## CVE assignment

For issues that warrant one, we request CVE assignment through GitHub's CNA integration as part of publishing the Security Advisory.

## Bug bounty

There is no monetary bug bounty at this time.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes — security fixes backported. |
| Pre-1.0 / `main` | Best-effort; track `main` for fixes. |
| Pre-release branches | No. |

Older 1.x point releases are supported for at least the duration of the current 1.x minor's lifetime. Adopters running modified forks are responsible for backporting fixes themselves.

## PGP / GPG

We do not currently publish a PGP key for encrypted reports. If you have a compelling need for encrypted communication, open a draft GitHub Security Advisory (which is itself private) and request a secure channel — we will arrange one for the duration of the disclosure.

## Acknowledgements

Named credits for reported vulnerabilities will be listed here as reports come in. If you would prefer to remain anonymous, say so in your report and we will honour that.
