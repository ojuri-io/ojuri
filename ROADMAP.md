# Roadmap

Where Ojuri is going. This file is intentionally forward-looking — for the
historical record of what changed in each release, see
[`CHANGELOG.md`](CHANGELOG.md).

This is open-source maintained by a small team. We do not commit to dates,
priority order is a working assumption that adopter pull can rearrange, and
external contributors are welcome to claim items via PR. Open an issue first
for anything non-trivial.

## Current state — 1.0

At launch (June 7, 2026) Ojuri ships:

- **Real-time path** — RDA with hot-reloaded rules (PRE / POST stages),
  catalogue-driven feature builder, ONNX inference with per-segment
  thresholds, inline reason codes, decision audit log, HMAC webhooks,
  idempotency keys, circuit-breaker degradation.
- **Async pipelines** — PAA graph + velocity, MLA drift + automated
  retraining + champion/challenger promotion gated on McNemar
  significance, FIA on-demand and Kafka-driven LLM investigations.
- **Model lifecycle** — filesystem registry with `CANDIDATE → SHADOW →
  ACTIVE → RETIRED` transitions, schema-version enforcement on load,
  hot-swap via `onActiveChange`, reviewer-override → `groundTruthFraud`
  retrain loop.
- **Sentinel operator dashboard** — review queue, transaction detail,
  rule editor + builder + templates, model registry, feature catalogue
  browser, audit log, saved reports with CSV/JSON export,
  investigations + conversational thread, users + roles, service health.
- **Adoption tooling** — synthetic-data load generator, decision replay
  CLI, full Docker Compose stack (NGINX + 3× RDA + 2× PAA + Postgres +
  Redis + Kafka + Prometheus + Grafana, with FIA gated behind a Compose
  profile so first boot is fast).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the technical
reference and [`CHANGELOG.md`](CHANGELOG.md) for the per-release detail.

## Planned

Grouped by what an adopter would be unblocking. Within each group items
are roughly priority-ordered; rearrange via PR or issue discussion if
your deployment needs something else first.

### Deployment + packaging

- **Helm chart** — Kubernetes-first adopters currently template their own
  manifests off `docker-compose.yml`. A first-party chart with sane
  defaults for the three RDA replicas, two PAA workers, the FIA opt-in,
  and the Postgres / Redis / Kafka externals is the highest-leverage
  follow-up on this list.
- **Terraform module** — companion to the Helm chart for cloud-resource
  provisioning (managed Postgres / Redis / MSK). Will likely live in its
  own repo to keep the core repo language-pure.

### Integration surface

- **Client SDKs in TypeScript and Python.** A typed `OjuriClient` with
  retries, idempotency-key helpers, and webhook signature verification
  beats hand-rolled HTTP for every adopter. The TS SDK can live in
  `clients/typescript/` and ship to npm; Python to PyPI as `ojuri-client`.
- **Pre-built connectors (Stripe / Adyen / Plaid).** Each is a small
  adapter that maps the provider's webhook or callback into a
  `POST /v1/predict` call and feeds the decision back into the
  provider's flow. Stripe is the highest-leverage to ship first.

### Security and access control

- **mTLS for service-to-service callers.** RDA→PAA, RDA→FIA, and any
  external machine client benefit from mutual auth in deployments where
  network segmentation alone isn't enough. Implemented as an NGINX
  client-cert config + an env flag on RDA's API-key middleware to
  accept verified certs in lieu of `X-Api-Key`.
- **OAuth 2.0 client-credentials grant for admin APIs.** Today admin
  surface is JWT-from-login or seeded service tokens. CC grant unlocks
  machine clients (CI, CLIs, partner integrations) authenticating
  against your IdP instead of holding a long-lived JWT.

### Compliance and regulated deployments

- **PII tokenisation hook before persistence.** A pluggable
  `tokeniseRequest(req): req` boundary applied before any write to
  `decisionAuditLog`, `transactions`, or Kafka, so the platform stores
  only tokens for `sender_id` / `receiver_id` / `customer_id_number`
  while the model still sees the raw values in-memory. Adopters in
  financial or healthcare deployments can plug in their tokenisation
  vendor without forking.
- **Region-pinned storage.** Operator config to constrain which
  Postgres / Kafka / model-registry paths a given tenant's data is
  written to — useful for adopters with explicit data-residency
  contracts.

### Model lifecycle

- **Canary traffic split by API-key cohort.** Today `SHADOW` runs the
  candidate on every request and writes its score alongside the
  champion's for offline comparison. Canary would route 1–10% of live
  traffic from a chosen API-key cohort to the candidate decision —
  graduated rollout instead of cliff-edge promotion.

### Adoption

- **Demo dataset under `data/demo/`.** A trimmed, anonymised dataset
  adopters can seed the stack with — a few thousand realistic
  transactions, labelled fraud, and pre-built rules to play with.
  Removes the cold-start "what do I evaluate against" problem.
- **Hosted sandbox.** A short-lived public deployment that adopters can
  point a curl at to try `/v1/predict` without standing up Postgres /
  Redis / Kafka locally. Infra-only; everything else on this list is
  shipped in the codebase.

## Out of scope

Things that are explicitly *not* planned, so contributors don't spend
cycles proposing them:

- **A managed / hosted SaaS offering.** Ojuri is and will remain a
  self-hosted platform. A hosted sandbox for evaluation (above) is
  different from a managed production tier.
- **Vendor-specific feature engineering.** The catalogue + adopter
  overlay is the extension point. We won't ship a Stripe-Radar-shaped
  feature set; adopters who want one extend the overlay.
- **Anything that puts FIA on the authorization hot path.** The LLM
  is async by design. Reports must continue to be generated off the
  predict path, no matter how fast LLMs get.

## Contributing to a roadmap item

If you want to work on any of the above, open an issue with the
roadmap section + item name in the title — that way the maintainer
can give scope guidance before you sink time into a PR. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).
