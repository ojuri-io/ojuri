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
  CLI, full Docker Compose stack (NGINX + 3× RDA + 1× PAA singleton + Postgres +
  Redis + Kafka + Prometheus + Grafana, with FIA gated behind a Compose
  profile so first boot is fast).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the technical
reference and [`CHANGELOG.md`](CHANGELOG.md) for the per-release detail.

## Planned

Grouped by what an adopter would be unblocking. Within each group items
are roughly priority-ordered; rearrange via PR or issue discussion if
your deployment needs something else first.

### Scaling beyond the singleton

The current PAA design holds the transaction graph and velocity
windows in process memory. It works comfortably for adopters under
~500 TPS sustained and ~1M active users in any 30-day window (see
`paa-service/README.md` § Sizing). Past that, several things bind in
order: event-loop saturation, Louvain compute time, then memory.
The items below are the realistic path for adopters targeting
Tier-1 mobile-money / large-bank volumes (>5M active users, multi-
thousand-TPS streams).

- **Externalised graph deployment profile.** Move the edge + node
  structure out of `graphology` into a server-side graph store
  (RedisGraph, Memgraph, or Neo4j with GDS). PAA becomes a set of
  stateless writers partitioned by Kafka key; a separate scheduled
  worker runs PageRank / Louvain server-side and writes results
  back into the same Redis hash RDA reads from today. Singleton
  consistency goes away — replaced by the graph store's
  transactional guarantees. Operational cost rises (one more
  stateful service) in exchange for linear ingestion scaling and
  graphs that fit beyond a single host's RAM.
- **Hot / cold split.** Cheaper middle ground for adopters who
  don't want to operate a graph DB. Keep PAA's in-memory graph
  bounded to the last 24–48 h of activity (small, fast,
  triangle-close detection stays real-time), and run a nightly
  batch job over the full transactions history to detect long-
  running rings and write community membership to a slow-changing
  Redis cache. RDA reads both; the model sees short-term + long-
  term signals. Trade: sub-hour ring detection on cross-day rings
  is lost, but those are the ones a nightly batch catches anyway.
- **Streaming / incremental community detection.** Replace
  `graphology-communities-louvain` (full recompute every tick) with
  a Louvain variant that warm-starts from the previous partition
  or a streaming algorithm (DynaMo, Streaming Louvain). At million-
  node scale, warm-starting cuts recompute from minutes to seconds.
  No maintained JavaScript implementation exists today — needs
  either a custom port or a worker-process call into a Python /
  Rust library. The current full-recompute design is the
  conservative choice but explicitly capped: PageRank ~`O(iters ×
  (V + E))`, Louvain empirical `O(V log V)` — both run cold every
  trigger.
- **Approximate / local centrality.** For per-event ring scoring,
  personalised PageRank seeded from the dirty edge converges in a
  bounded neighbourhood — `O(local degree)` instead of `O(V + E)`.
  Pairs naturally with the existing triangle-close trigger:
  recompute centrality only for nodes touched by the new edge,
  cheap enough to fire on every event without the
  `TRIANGLE_RECOMPUTE_MIN_INTERVAL_MS` throttle.
- **Configurable velocity history cap.** The
  `MAX_TRANSACTIONS_PER_USER = 1000` constant in
  `paa-service/src/services/velocity.service.ts` is currently
  hard-coded. Surface as `VELOCITY_MAX_RECORDS_PER_USER` env var so
  adopters with very high-throughput super-agents (running orders
  of magnitude over the cap per day) can shrink the per-user
  history to control memory.

### Graph and feature pipeline correctness

Open improvements to the analytics layer that don't strictly need
high TPS to matter. They're called out separately so adopters
running smaller deployments can pull them forward when they hit a
specific gap.

- **Derived community features replace raw `community_id`.**
  Vanilla Louvain integer labels are non-deterministic across
  runs, so the raw ID flowing through the ONNX input vector as an
  ordinal numeric (catalogue index 22, `dtype: uint8`) is at best
  noise and at worst misleading the model. Replace with
  `graph_community_size`, `graph_community_decline_rate`, and
  `graph_community_intra_share` — all stable under relabeling and
  far more predictive. Requires a model retrain when the catalogue
  schema bumps, so bundle with whatever drives the next MLA
  training run.
- **Middle-node snapshot refresh on triangle close.** When a new
  edge closes a 3-cycle and triggers a recompute, the sender and
  receiver of that event get their post-compute snapshots written
  to Postgres in the same handler — but the third "middle" node of
  the cycle does not. Its snapshot in `graphMetadata` lags by one
  outgoing event. Active ring members refresh on their next
  transaction; pure pass-through nodes can stay stale indefinitely.
  Cheap fix: surface the middle nodes from `closesDirectedTriangle`
  and queue them alongside.
- **Edge weight decay.** Edge `weight` and `totalAmount` only
  accumulate, never decay. A relationship that was active a year
  ago but quiet since has the same graph signal as a current one.
  Add age-weighted decay (half-life ~30 d) so the centrality
  scores reflect *current* network structure, not lifetime
  history.
- **Surface `transactionTypes` as features.** The per-edge
  `Set<string>` is captured but never read downstream. Promote to
  features like `pair_has_cashout`, `pair_channel_diversity` so
  ring signatures (e.g., "every leg is CASH_OUT") become learnable.
- **Minimum community size and quality gates for Louvain.** Tiny
  isolated pairs become their own community, indistinguishable
  from genuinely-meaningful clusters in the integer label. Apply a
  minimum-size threshold (e.g., communities <3 nodes get assigned
  community 0 = "no meaningful community"), and surface community
  modularity as a per-prediction confidence signal.
- **Graph-poisoning defences.** No edge-weight cap, no minimum-
  amount filter on graph admission, no edge-age decay (above) —
  an adversary can inflate a target's PageRank by spraying tiny
  transactions toward them from controlled accounts. Cheap to add
  alongside the decay work.

### Operability of high-scale deployments

Items adopters who hit the ceiling need to *notice* before they're
in production trouble.

- **Alert when scheduled prune finds zero eligible victims.**
  Today's failure mode is a silent climb to OOM: the cap fires,
  the prune walks every node looking for `lastSeen < cutoff`,
  finds none (all users active in last 30 d), and PAA keeps
  growing. Add a metric `paa_graph_prune_inelligible_total` and a
  log line at WARN when a prune attempt frees zero slots — that's
  the precursor to OOM.
- **Sentinel sizing panel.** Surface `paa_graph_size`,
  `paa_consumer_lag`, `paa_group_members`, and the velocity-user
  count as a single "PAA capacity" widget so operators see when
  they're approaching either ceiling without learning Prometheus.
- **Manual recompute trigger.** `POST /v1/admin/paa/recompute` for
  ops to force a `computeNetworkMetrics()` on demand — useful for
  ring investigations where the operator wants the freshest
  partition immediately rather than waiting for the next tick.
- **Dirty-triangle backlog metric.** Counter for how often the
  triangle-close trigger fired and how many recomputes it caused.
  Tells operators whether they're getting ring-detection latency
  benefit or just paying for extra recomputes.

### Deployment + packaging

- **Helm chart** — Kubernetes-first adopters currently template their own
  manifests off `docker-compose.yml`. A first-party chart with sane
  defaults for the three RDA replicas, the PAA singleton, the FIA opt-in,
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
