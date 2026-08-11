# Changelog

All notable changes to Ojuri will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-08-11

Ships a one-instance AWS deployment and fixes three defects found while
standing it up — two of which made services unrunnable rather than
merely awkward. The MLA and FIA fixes change the published images, so
adopters on the floating `:v1` tag receive them automatically.

### Added

- **AWS test environment (`deploy/aws/`)** — Terraform for a single EC2
  instance running the whole stack behind CloudFront with AWS-managed
  TLS, plus a runbook aimed at operators who are not DevOps engineers.
  Ingress is limited to CloudFront's origin-facing prefix list, shell
  access is SSM Session Manager (no port 22, no key pair), data stores
  bind to loopback, IMDSv2 is required with a hop limit of 1 so no
  container can reach the instance role, and every secret is generated
  into SSM Parameter Store rather than living in the repo. The instance
  stops itself when idle and can be woken from a public button, which
  keeps a continuously-available environment at roughly a third of the
  cost of leaving it running.
- **`sentinel` service in `docker-compose.yml`**, behind a `sentinel`
  profile. The image was already published but had no compose service
  and no ingress route, so the dashboard could not be served from the
  shipped stack. A plain `docker compose up` is unchanged.
- **`ADMIN_SEED_PASSWORD` passed through to `db-migrate`**, so the seed
  migration's existing support for a supplied password can actually be
  used. Unset still generates a random one and prints it once.

### Fixed

- **RDA could not boot with `NODE_ENV=production` from the shipped
  compose file** ([#121](https://github.com/ojuri-io/ojuri/issues/121)).
  `SENTINEL_CORS_ORIGINS` was never passed into the container, and the
  production guard treats its absence as fatal — so the default
  configuration crash-looped on *"Refusing to boot with unsafe
  defaults"*. Setting it in `.env` did not help: `.env` populates
  Compose's interpolation scope, and a variable only reaches a container
  if the service's `environment:` block names it.
- **MLA crash-looped on modern kernels**
  ([#122](https://github.com/ojuri-io/ojuri/issues/122)).
  `onnxruntime==1.16.3` ships a native extension marked as requiring an
  executable stack, which current loaders refuse — the import failed
  before the service started. Now `1.19.2`. The runtime is independent
  of the `onnx` / `onnxmltools` / `onnxconverter-common` pins that exist
  for XGBoost conversion; those are unchanged and
  `tests/test_onnx_conversion.py` passes against the new runtime.
- **FIA silently degraded to rule-based reports on any CUDA host.**
  `phi3_generator` requested `attn_implementation="flash_attention_2"`
  whenever CUDA was present, but `flash-attn` is not a dependency.
  transformers raised, the fallback caught it, and the only outward sign
  was `llmModelVersion` ending in `-fallback` — on a GPU rented
  specifically to avoid that. It now falls back to `eager` when
  `flash_attn` is unavailable. The bug was invisible because every
  measured run had been on Apple Silicon MPS, which takes the `eager`
  branch.

### Known issues

- **`nginx/nginx.conf` does not strip the `/fia/` and `/mla/` prefixes**
  ([#123](https://github.com/ojuri-io/ojuri/issues/123)), so Sentinel's
  FIA report and MLA retrain calls 404 against the shipped stack. nginx
  only substitutes the location prefix when `proxy_pass` names a literal
  upstream, and both routes use a variable. The fix is proven in
  `deploy/aws/nginx/nginx.conf` but deliberately not applied to the
  shared config in this release — it changes the ingress path for every
  adopter and wants review on its own merits.

## [1.4.0] - 2026-08-09

This release remediates a full line-by-line architecture review — 45
findings across three rounds (OJR-01–45, per-finding evidence in
`docs/REVIEW_FINDINGS.md`) — and ships a flag-gated log-first audit
pipeline. It also makes permission changes apply to live sessions and
the RDA replica count configurable. No API surface changes, but several
decision-path behaviours differ from 1.3.0 (see Changed) and every fix
was re-verified against a live compose stack: 2,000-request load test
all HTTP 200, p99 84.5 ms at 16-way concurrency vs the 295 ms pre-fix
baseline.

### Added

- **Log-first audit pipeline (`AUDIT_PIPELINE=stream`, default
  `queue`)** — the decision event carries the full audit payload and is
  published with an awaited `acks=all` send before the response;
  `AuditStreamConsumer` materialises `decisionAuditLog` from the topic,
  and late values (shadow scores, early-PRE feature snapshots) follow
  as `audit.enrichments` events applied as idempotent UPDATEs. Audit
  durability moves from "row survives unless the process dies before
  flush" to "row durable in Kafka before the caller sees the decision".
  Measured: p50/p95/RPS parity with the queue, +10–19 ms p99
  end-to-end; server-side decision path p50 1 ms / p99 5 ms; enrichment
  delivery 100% (queue mode's patch race dropped ~15% of early-PRE
  snapshots). Closes OJR-07 when enabled; the checklist for making it
  the default (a major-release change — Kafka becomes a hard dependency
  of `/v1/predict`) is in `docs/REVIEW_FINDINGS.md`. Full measurements:
  `docs/LOG_FIRST_AUDIT_PROTOTYPE.md`. The prod compose stack threads
  `AUDIT_PIPELINE` through to the RDA replicas, so the `.env` opt-in
  works on `docker compose up` (previously dev-overlay only).
- **Score calibration reaches serving** — RDA loads the isotonic
  breakpoints from `meta.json` and applies them after ONNX output.
  `ONNX_CALIBRATION_MODE` defaults to `observe`: the calibrated score
  is recorded as `decisionAuditLog.calibratedScore` while decisions
  still use the raw score, because every shipped threshold was tuned
  against the raw distribution. Flip to `enforce` only after
  re-deriving thresholds from calibrated audit data.
- **PAA leader lease** — PAA takes a Redis lease
  (`ojuri:paa:leader`) before consuming; a second instance waits for
  handover then exits instead of joining the consumer group and
  splitting the graph. Renewal fails closed on elapsed TTL, and a
  fenced-out instance discards its buffers rather than flushing a
  partial-graph snapshot over the new leader's writes.
  `PAA_REQUIRE_LEADER_LEASE=false` disables the fence.

### Changed

- **The ONNX breaker fallback is REVIEW, not DECLINE.** opossum fires
  the fallback on per-call timeouts too, so a timeout below the
  measured p95 under concurrency turned ordinary contention into
  customer-facing declines. `CB_ONNX_TIMEOUT` now defaults to 750 ms,
  the fallback returns `{ degraded: true }`, and `PredictService` maps
  it to `CB_ONNX_FALLBACK_DECISION` (default REVIEW) with
  `decisionSource = BREAKER_FALLBACK`. Degraded declines are no longer
  published to `transactions.blocked` — there is no model signal for
  FIA to investigate.
- **Drift F1 threshold anchors to the deployed champion** — the
  window alarm fires at (champion validation F1 −
  `DRIFT_F1_MARGIN`) instead of the static `DRIFT_F1_THRESHOLD`, which
  stays as the fallback when no champion metrics exist.
- **Model hot-reload serves the version artefact directly** — the copy
  into the canonical `MODEL_PATH` is best-effort (the compose files
  mount `models/` read-only; EROFS is expected), and a champion that
  was ACTIVE before boot is applied at startup, so cold restarts no
  longer silently fall back to whatever the canonical file holds.
- **Dev containers run the mounted source directly** —
  `module-alias` registers only in compiled builds
  (`src/register-aliases.ts`); under ts-node, `tsconfig-paths` resolves
  aliases to `src/*.ts`, keeping one module universe (two resolvers
  duplicated every tsyringe singleton). nodemon uses `legacyWatch` so
  host-side edits through the Docker mount trigger restarts on macOS.
  No in-container `npx tsc` after edits any more.
- **Configurable RDA replica count (`RDA_REPLICAS`, default 3)** — the
  three hand-copied `rda-1/2/3` compose services collapse into a single
  `rda` service scaled via `deploy.replicas`. NGINX balances across the
  replica IPs Docker DNS returns (restart nginx after changing the
  count so it re-resolves), and Prometheus discovers replicas via DNS
  service discovery instead of static targets. The GHCR overlay and CI
  reference the `rda` service name; per-replica names (`rda-1:3000`
  upstreams, static scrape targets) are gone — update any scripts that
  addressed replicas by name.

### Fixed

45 findings; the tracker has per-finding detail. Highlights by service:

- **MLA** — the isotonic calibrator previously affected only the
  reported Brier score and never a served score; the calibration split
  is carved before SMOTE (fitting on oversampled rows targeted a ~50%
  synthetic base rate); drift windows are fed from Postgres ground
  truth on the label poll (they previously never received a sample, so
  F1/PSI drift could not fire); the label-volume watermark anchors to
  the last succeeded `retrainRuns` row, so labels arriving while MLA is
  down still count after a restart.
- **PAA** — graph cap is a true LRU; velocity windows are retained by
  time, not count; replayed events dedupe instead of double-counting;
  graph metadata snapshots for both parties on every event.
- **RDA** — audit ids are tenant-scoped; the audit requeue path bounds
  poison entries; the LevelDB replay buffer preserves topic and
  partition key per entry (`{ v: 2, ... }` envelope).
- **FIA** — poison messages are bounded by a retry counter and
  committed past instead of wedging a partition; offsets commit
  per-partition only.
- **Dev/compose** — `db-migrate` and dev services carry the env they
  need (`MLA_SERVICE_TOKEN`, `AUDIT_PIPELINE` passthrough).
- **Permission changes now apply mid-session** — the JWT authenticates
  identity only; `requireAuth` resolves permissions, `isActive`, and
  `mustChangePassword` from Postgres per request through a 30 s
  in-process grants cache (`AuthService.verifyTokenLive`). Role edits,
  role (un)assignment, user deactivation/deletion, and forced password
  rotation take effect on live sessions within the cache TTL —
  instantly on the replica that handled the admin call — instead of on
  the user's next login (previously up to the 8 h token TTL). The
  token's permission claim is still minted for compatibility but is
  never consulted for authorization.
- **`/readyz` through NGINX no longer 404s** — `location /ready`
  prefix-matched `/readyz` and the `proxy_pass` URI rewrite sent
  `/readyzz` upstream. The `/health` and `/ready` aliases are exact
  matches now, so the app's own `/livez` and `/readyz` pass through
  the catch-all unchanged.

- **`scripts/demo-traffic.mjs` defaulted to an unreachable URL** — the
  default `http://localhost:3000` is not published by the production
  compose stack (NGINX answers on `:80`), so the documented host-side
  invocation exited with "RDA is unreachable". It now probes `:80` then
  `:3000`, so both the Docker stack and `npm run start:dev` work with no
  `RDA_URL` set. An explicit `RDA_URL` is still used verbatim.

### Documentation

- **README restructured around the adopter journey** — quick start
  first, then what the platform does, then a path split for
  evaluating / integrating / operating / contributing. Install
  prerequisites and the build-from-source path moved into collapsed
  sections, and symptoms moved to the new
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). Prose rewritten
  in plain language throughout.
- **Corrected README instructions that failed when executed** — the
  quick-start `curl` returns 409 on a second run (fixed
  `transaction_id`, now called out); the sample response showed
  `threshold` 0.65 on a `TRANSFER` payload where the seeded segment
  threshold is 0.30, and omitted the `basis` field on reason codes;
  `"model_version": "default"` was described as no model being
  registered, when `00_initial_model_version` seeds exactly that
  version as ACTIVE on purpose; `frontend/.env.example` already targets
  the Docker stack, so the instruction to uncomment that block was
  stale; and `python --version` fails where no bare `python` exists, so
  the MLA setup now creates the venv with `python3.11`.
- **`docs/ARCHITECTURE.md` performance table** now carries the
  post-review contended measurement (p99 84.5 ms, ~516 RPS) alongside
  the superseded 295 ms baseline, which the table had been presenting
  as current.

### Notes

- Round 2 of the review (OJR-27–40) consisted of defects introduced by
  round 1's fixes, found by three independent re-reviews — the tracker
  keeps the full chain visible.
- Reference performance in CLAUDE.md was re-measured post-fix; the
  honest contended baseline is now p99 84.5 ms (was 295 ms).

## [1.3.0] - 2026-07-07

This release acts on an independent efficacy validation of the shipped
stack (`efficacy-validation/`). It fixes four correctness gaps between
what the platform did and what its own contracts/README claimed, and
adds two detection improvements. Existing deployments are unaffected —
both seed changes skip rows that already exist — but **fresh installs
behave differently on day 1** (see Changed).

### Added

- **Behavioral rule pack (`04_behavioral_rule_pack.ts`)** — two POST-stage
  REVIEW rules on PAA-derived features (`velocity_1h`,
  `unique_receivers_24h`), guarded to exclude agents and corporates.
  Turns PAA's velocity/graph signals into verdicts the ML model misses
  on trusted, authenticated traffic. Measured against the efficacy
  harness: velocity-anomaly recall 0.00 → 0.80 with zero added false
  positives on agent-network, payroll, airtime, and remittance traffic.
  Every feature it reads defaults to 0 on a Redis miss, so the pack is
  cold-start-safe.
- **Context-field dropout augmentation (MLA)** — training appends
  context-zeroed copies of a fraction (`CONTEXT_DROPOUT_FRACTION`,
  default 0.4) of the training rows so the model scores on behaviour,
  not payload richness, fixing the shipped model's trust-context
  degeneracy (a bare payload scored ~1.0, full context ~0.0).
  `CONTEXT_DROPOUT_ENABLED` (default on). See
  `mla-service/docs/CONTEXT_DROPOUT_RETRAIN.md` for the runbook and the
  measured result: the mechanism closes the context gap (0.9998 →
  0.0009) but does not by itself add behavioural typology recall — that
  requires training data containing those patterns as fraud.
- **Context-sensitivity probe (RDA)** — alongside the calibration probe,
  every model load and hot-swap scores the same transaction with and
  without context fields and warns (exposing the gap via
  `getModelInfo()`) when the model keys on integration context rather
  than behaviour.

### Changed

- **The demo rule pack now seeds inactive by default.** Its amount
  thresholds are demo-dataset props that flag large slices of real
  traffic (declining every txn ≥ ₦100k, reviewing every ₦500–10k
  PAYMENT) and shadow the FATF pack. Set `SEED_DEMO_RULES_ACTIVE=true`
  before the first seed run to restore the old behaviour for the demo
  dataset. Existing rules keep their operator-set `isActive` state.
- **Fresh installs now register the shipped model and per-type
  thresholds.** The `db-migrate` container previously lacked the
  `models/` mount, so the initial-model seed silently skipped — every
  decision fell back to a flat 0.65 threshold with an empty registry.
  Fresh installs now score with the registered `default` model and its
  segment thresholds (CASH_OUT 0.70, TRANSFER 0.30, …), so day-1
  verdicts differ from 1.2.0's. `v1.x` stays reserved for adopter-trained
  models.
- **Calendar features are computed correctly for the first time.** Both
  RDA serving and MLA training mis-handled the millisecond event
  timestamp (RDA multiplied by 1000; MLA parsed as nanoseconds and
  trained on ingestion time), so `hour_of_day` / `day_of_week` /
  `is_weekend` / `is_payday_window` / `is_off_hours` were noise.
  Verified zero decision change on the deployed model (it barely
  weighted these), but retrain before relying on time-of-day signals.

### Notes

- Deployments upgrading from 1.2.0 will see a one-time
  context-sensitivity warning in the RDA logs against the shipped model
  — that is the new probe working, not a regression.

## [1.2.0] - 2026-07-02

This release closes the label feedback loop — the core mechanism that
lets a self-hosted deployment improve on its own outcomes the way
closed fraud vendors do — and fixes four correctness gaps where the
platform silently did less than its own contracts claimed. Models
trained before 1.2.0 keep working, but see the "Changed" notes on
score distributions before relying on pre-1.2.0 thresholds.

### Added

- **Ground-truth label ingestion API** (#81). `POST /v1/admin/labels`
  (new `labels:write` permission) accepts up to 1,000 verified
  outcomes per batch — chargebacks, disputes, customer reports — and
  upserts `transactions.groundTruthFraud` with provenance. Duplicates
  in a batch collapse last-wins; the response splits `applied` vs
  `unmatched` so callers can retry rows PAA hasn't flushed yet.
  `GroundTruthSource` is now a shared enum across the label paths.
  `docs/ADOPTER_TRAINING.md` §4 documents the flow.
- **MLA label-volume retrain trigger** (#81). MLA counts labels
  recorded since its watermark every `LABEL_CHECK_INTERVAL_SECONDS`
  (default 900) and retrains once `LABEL_RETRAIN_THRESHOLD` (default
  500; `0` disables) accumulate — fresh verified labels reach the
  model on their own schedule instead of waiting for F1 drift, which
  is 3–7 days label-delayed by nature. Runs with or without Kafka,
  respects `autoRetrainEnabled`, and reports `label_volume_checks` /
  `labels_pending_retrain` in `/stats`. The registry treats the
  `label_volume` trigger like `drift` (auto-activate on gate pass).
- **PAA fraud-proximity graph features** (#82). PAA polls
  confirmed-fraud transactions (every `FRAUD_LABEL_POLL_INTERVAL_MS`,
  default 5 min) and marks both parties as fraud nodes, making two
  previously always-default catalogue features real:
  `graph_shortest_path_to_fraud` (undirected BFS, depth-capped at 4,
  visit-capped at 1000) and `graph_neighborhood_fraud_rate` (fraction
  of flagged 1-hop out-neighbors). `recipient_dispute_rate` is now
  the only contracted feature without a writer, enforced by test.
- **Real shadow-model scoring** (#83). The SHADOW registry status now
  does what it says: OnnxService keeps a small second session pool for
  the shadow version (same feature-schema-version refusal as the
  champion), scores it on every ML-scored predict overlapped with the
  reason-code/POST-rule stages, and writes `shadowScore` onto the same
  `decisionAuditLog` row. Strictly observational — failures record
  null and never touch the decision or `/readyz`. New
  `shadow_inference` stage metric.
- **PAA delivers the full `paa:redis` feature contract** (#78).
  Previously only 11 of the ~20 contracted features were written; the
  model scored on catalogue defaults for the rest, permanently. Now
  implemented: `velocity_1m/5m/15m`, `amount_mean_24h`,
  `amount_max_24h`, `unique_receivers_24h/7d` (fan-out signal),
  `hour_dev_from_sender_norm`, `graph_is_hub` (top 0.1% out-degree
  with an absolute floor), `recipient_lifetime_tx_count` (kept fresh
  on pure receivers via partial updates), and a full pair block on a
  new `features:pair:{sender}:{receiver}` hash (30-day TTL):
  `pair_is_first_send`, `pair_prior_send_count`,
  `pair_time_since_last_send`, `pair_round_trip_count_30d`,
  `pair_amount_mean_30d`. RDA fetches sender + pair + receiver hashes
  in one pipelined round trip. A contract test fails the build if a
  contracted feature loses its writer.
- **REVIEW band on the ML score** (#87). A new `review_margin` runtime
  setting (seeded 0 = off) routes scores in
  `[threshold − margin, threshold)` to a REVIEW decision and into the
  analyst queue instead of a silent ACCEPT — turning model uncertainty
  into ground-truth labels. Tracks the per-segment threshold
  resolution; REVIEW is observational on the wire (`fraud: false`,
  never published to the blocked topic). Settings gains a Review band
  card with sizing guidance.
- **MLA temporal train/test splits** (#88). Training rows are
  time-ordered and split positionally — train on the past, evaluate on
  the future. The previous stratified random split leaked future rows
  into training and inflated every metric the deployment gate reads.
  Falls back to the stratified split for degenerate datasets.
- **MLA absolute deploy floor** (#88). `MIN_DEPLOY_F1` (default 0.3):
  the validator refuses candidates below the floor even when they beat
  the incumbent, and cold-start models below it register as CANDIDATE
  for operator review instead of auto-activating.
- **Sentinel Labels page + label-feedback card** (#86). Manual entry
  for verified outcomes (paste ids, per-line verdicts, source picker)
  posting to the labels API, and a Settings card showing "labels until
  next retrain" from MLA `/stats`.
- **Fraud simulation benchmark** (#90). `scripts/fraud-sim.mjs` +
  `scripts/fraud-sim-score.py` + `docs/FRAUD_SIMULATION.md`: a
  deterministic persona population with six embedded fraud typologies
  (half deliberately rule-evading) driven through `/v1/predict` over a
  simulated multi-week window, scored per typology against ground
  truth. Reference run: 128k transactions, 34.2% of fraud caught cold
  → 98.8% at 1.1% FPR after one label-driven retrain, on fraud
  identities the model never saw.
- **Live ground-truth metrics in champion-vs-shadow** (#91). The
  comparison endpoint computes per-model precision/recall/F1 and
  McNemar's p from labelled decisions in the window instead of
  hardcoding null; the Models page prefers live values over training
  metrics, √-scales the score histogram, and fixes the off-plot
  tooltip.
- **Demo traffic seeder** (#84). `docker compose --profile demo run
  --rm demo-seed` (or `node scripts/demo-traffic.mjs`) posts ~500
  realistic NGN transactions — 50 recurring senders plus an embedded
  money ring, a 30-receiver mule fan-out, VPN sessions, and a
  structuring sequence — so a fresh install has a populated dashboard
  and firing rules within a minute. Zero npm dependencies.

### Fixed

- **Reason codes were misattributed** (#77). The explainer used
  pre-catalogue vector indices, so every code read a different feature
  than its label claimed (`AMOUNT_HIGH` was computed from
  `unique_receivers_24h`, `PAGERANK` from `velocity_7d`, …). Specs now
  resolve positions from the feature catalogue by name; a regression
  test pins the attribution. `PAGERANK` baselines moved to realistic
  per-node magnitudes so it no longer adds a large constant to every
  explanation.
- **`pair_time_since_last_send` semantics** (#78). Was the sender's
  time since their last transaction to *anyone*, mislabeled to the
  model as pair recency. Now genuinely pair-scoped.
- **MLA deployment gate had an escape hatch** (#79). A candidate
  deployed on F1 improvement alone, bypassing both the McNemar
  significance requirement and the >5% precision/recall regression
  guards. All three gates are now binding.
- **MLA PSI data-drift detection was inert** (#80). The consumer fed
  the detector fields the Kafka event doesn't carry (fabricated as
  constant 0) under names that didn't match the baseline's catalogue
  keys. PSI now monitors only fields actually present on the event
  (`amount`, `account_age_days`, `session_to_txn_seconds`) under exact
  catalogue names, omitting absent fields instead of defaulting them.
- **PAA first Redis flush no longer silently dropped** (#89). The
  worker now waits for Redis readiness before consuming Kafka — the
  lazy client raced the first batch flush and every write in it was
  counted as an error and discarded. Also quiets the fraud-sync log
  re-reporting the same users every poll.
- **Isotonic calibrator was dropped on automated retrains** (#88). Only
  the cold-start script persisted it, so the first drift/label-volume
  retrain silently shipped uncalibrated scores. `upload_model` now
  writes `calibrator.npz` into every version directory.

### Changed

- **Score distributions will shift after deploying 1.2.0.** Models
  trained before this release learned on default values for the ~9
  newly-delivered PAA features (#78) and the two fraud-proximity
  features (#82); once real values flow, scores move. Plan a retrain
  shortly after deploying, and re-validate any hand-tuned per-segment
  thresholds against post-upgrade audit data.
- Shadow scoring adds one extra ONNX inference per ML-scored request
  *while a SHADOW model is staged* (#83). No cost when no shadow is
  registered. If throughput matters on small hardware, retire the
  shadow when the comparison window is done.
- `POST /v1/admin/labels` requires the new `labels:write` permission —
  grant it to the role your ops integration uses before pointing a
  chargeback feed at it (#81).
- Post-1.2.0 training metrics will read **lower** than pre-1.2.0
  numbers for the same data (#88) — the temporal split removes the
  future-leak inflation. That drop is honesty, not regression; compare
  models within the same split methodology only.
- The review queue now includes REVIEW-decision rows alongside
  DECLINEs (#87). Queue volume is unchanged until an operator sets a
  non-zero `review_margin`.

## [1.1.0] - 2026-06-22

First tagged release. v1.0.0 (2026-06-07) was the soft launch; v1.1.0 is the
first version with a formal git tag, signed container images on GHCR
(`ghcr.io/ojuri-io/{rda,paa,mla,fia,sentinel}`), and a GitHub Release.
Adopters should pin to `:v1` (floating, receives future minors and patches)
or `:v1.1.0` (strict). See [`VERSIONING.md`](./VERSIONING.md).

This release adds the post-v1.0.0 graph-coherence work, adopter training-data
ingest, FATF rule pack, MLA score calibration, per-segment threshold defaults,
and several PAA scale/correctness fixes.

### Added

- **PAA durable edge + node state in Postgres.** New `transactionEdges`
  table (Knex migration `20260608000001`) holds the directed-edge
  list; `graphMetadata` finally gets the `firstSeen` / `lastSeen` /
  `transactionCount` / `totalAmount` / `inDegree` / `outDegree`
  columns populated alongside the existing pagerank / community /
  clustering outputs. On boot, PAA hydrates the in-memory
  `graphology` instance from these tables first and only tails
  transactions newer than the latest persisted edge timestamp. Rings
  whose seed edges fall outside the 30 d / 100 k row replay window
  stop being forgotten across restarts.
- **PAA singleton runtime guard.** New `paa_group_members` Prometheus
  gauge that must stay at 1; PAA logs ERROR if a second consumer
  joins the `pattern-analysis` group. Backstops the compose change
  for ops scenarios (rolling restart overlap, accidental scale-up,
  helm-chart drift) where the in-memory graph would otherwise be
  fragmented across replicas.
- **Triangle-close recompute trigger.** When a new edge closes a
  directed 3-cycle (`A → B`, `B → C` already exists, `C → A` already
  exists), PAA fires `computeNetworkMetrics()` on the next event
  instead of waiting up to 5 minutes for the scheduled tick. Burst
  rings whose edges land in a tight window stop being invisible
  during the gap. Throttled by `TRIANGLE_RECOMPUTE_MIN_INTERVAL_MS`
  (default `10000`) so a flurry of ring-forming events doesn't
  thrash the recompute path.
- **PAA sizing guidance** in `paa-service/README.md`. Covers what a
  node represents, what actually happens at the `MAX_GRAPH_NODES`
  cap (silent crash loop when no nodes are stale enough to evict),
  and the two binding ceilings (1–2k TPS sustained typical, dropping
  toward 200–500 with high-degree receiver hubs or graphs past ~500k
  nodes; ~1M nodes memory) with a profile-by-profile sizing table
  from demo through Tier-1.

- **Adopter training-data ingest.** Operators can now upload labelled
  transaction CSVs through the Sentinel "Training imports" page or via
  the file-based API. Upload protocol is chunked (5 MB chunks, SHA-256
  verify on assemble) so multi-hundred-thousand-row files survive
  network blips: `POST /v1/admin/training/upload/init` →
  `PUT /v1/admin/training/upload/:id/chunk` × N →
  `POST /v1/admin/training/upload/:id/complete` →
  `POST /v1/admin/training/import/:jobId/promote` →
  `POST /mla/v1/admin/retrain`. Column renames and default values are
  applied in the UI (no need to re-export the CSV); a downloadable
  template surfaces the canonical headers. New tables: `trainingJobs`,
  `trainingUploads`, `transactionsStaging`. See `docs/ADOPTER_TRAINING.md`.
- **Per-segment fraud-threshold defaults** seeded for every
  PaySim transaction type in
  `src/database/seeds/02_segment_thresholds.ts`: CASH_OUT=0.70,
  TRANSFER=0.30, PAYMENT=0.50, DEBIT=0.50, CASH_IN=0.50. Resolution
  uses `request.segment ?? request.transaction_type` so adopters get
  segment-aware thresholds with no UI work.
- **FATF default rule pack** under `src/database/seeds/03_fatf_rule_pack.ts`:
  five rules covering structuring (CASH_OUT under the cash-reporting
  threshold), VPN+significant-amount, outbound TRANSFER to FATF
  high-risk corridors, account-takeover signature
  (rushed session + cross-country IP + high amount), and untrusted
  device + significant amount. Defaults are NGN-tuned; edit per-market.
- **MLA isotonic calibration** wraps the post-XGBoost score with
  `sklearn.IsotonicRegression`, fitted on a held-out 10% split. The
  Brier score (calibrated and uncalibrated) is recorded in
  `meta.json` and persisted to the `modelVersions.brierScore` column
  so adopters can spot saturation regressions across versions.
- **User-controlled training mode.** New `mlaSettings.trainingMode`
  (`FRESH` | `CONTINUED`) and `mlaSettings.continuedTreesPerRound`
  let operators choose between full retraining (current behaviour)
  and incremental boosting on top of the current production model
  (XGBoost `xgb_model=`). Surfaced as a dropdown on the Settings
  page; `PUT /mla/v1/admin/drift-config` accepts the two new fields.
- **Rule visibility in audit and predict response.** Every
  `/v1/predict` response now carries a `rule` object when a PRE or
  POST rule fired (`{ id, name, stage, action, expression }`), and
  the decision-audit row stores the rule expression so the Sentinel
  detail page can render exactly which rule caused a DECLINE.
- **Curated demo dataset and one-shot loader.** A 20-row
  `data/demo/sample-transactions.json` hand-built to exercise all three
  decision buckets, plus `npm run demo:load` (extends `scripts/seed-load.ts`
  with a `--file` flag that re-mints `transaction_id` / `timestamp` per
  send so the dataset can be replayed without idempotency collisions).
- **Demo rules seed** under `src/database/seeds/01_demo_rules.ts`,
  installed by `npm run db:seed`. Four PRE-stage rules keyed on
  `amount` / `transaction_type` / `segment` so the demo dataset produces
  a visible ~9 ACCEPT / ~4 REVIEW / ~7 DECLINE split out of the box even
  on a fresh deploy with no PAA cache.
- **Regression guard** for the demo dataset shape: seven Jest assertions
  (`test/demo/demo-dataset.spec.ts`) that fail CI if the JSON drifts
  from the predict-API contract.
- README quickstart now mentions `npm run reset:admin` for the
  "I lost the seeded password" recovery path.
- `.env.example` now documents 11 previously-undocumented env vars
  (BRAND_NAME, FEATURE_CATALOG_BASE_PATH / ADOPTER_PATH /
  FEATURE_LOOKUP_ROOT, the four `*_HEALTH_URL` knobs,
  HEALTH_PROBE_TIMEOUT_MS, MODEL_VERSION_LABEL, MODEL_INPUT_DIMENSION).

### Changed

- **PAA is now a singleton by design.** `paa-2` removed from
  `docker-compose.yml`; `deploy.replicas: 1` pins the remaining
  `paa-1` service; Prometheus scrape config and CI log-dump list
  trimmed accordingly. Reason: PAA holds the transaction graph and
  velocity windows in process memory, and Kafka partition assignment
  splits the event stream across replicas — running two means each
  computes PageRank / Louvain on a partial graph and any ring whose
  members hash to different partitions becomes invisible. Adopters
  running past the singleton's sustained-throughput ceiling
  (typically >2k TPS, sooner for graphs >500k nodes or when high-
  degree receiver hubs dominate) will eventually want the
  externalised-graph deployment profile (separate work) instead of
  scaling PAA.
- **PAA `graphMetadata` populated on every event for both sender and
  receiver.** Previously the trigger was `processedCount % 100 === 0`
  and only the sender was snapshotted, which dropped 99 % of writes
  and left pure-receiver nodes (mules, drain points) missing from
  the table entirely. The flush path also switched from a per-row
  upsert loop to a single bulk `INSERT … ON CONFLICT … MERGE` per
  batch.
- **PAA `pruneOldNodes` switched to event-time clock and an hourly
  schedule.** Was wall-clock (mis-classifying historical replays as
  recent) and only cap-driven (so the prune effectively never fired
  in practice). Now tracks the max observed event timestamp and runs
  on a 1 h interval in addition to the existing cap path; the cap
  path still drops the oldest 10 % as a relief valve, but the
  scheduled path drops everything past the 30 d cutoff.
- **NGINX `/mla/` proxy hardened for Linux hosts.** The new `location
  /mla/` block defers `host.docker.internal` resolution to request time
  (variable in `proxy_pass` + embedded resolver), and the `nginx`
  service in `docker-compose.yml` now declares
  `extra_hosts: host.docker.internal:host-gateway`. Without this, nginx
  hard-fails at startup on Linux CI runners and the Sentinel
  "Retrain now" / drift-config calls return 502.
- **Predict service refactored** into named stages
  (`resolveModel`, `loadFeatures`, `evaluatePreRules`, `runInference`,
  `evaluatePostRules`, `finalize`) backed by factories
  (`DecisionAuditFactory`, `PredictDecisionContextFactory`,
  `TransactionEventFactory`, `PredictResponseFactory`). No behavioural
  change; the request hot path is now legible from a single 40-line
  method.
- Tighter TypeScript strict-family coverage. RDA gained
  `noImplicitAny`, `strictPropertyInitialization`,
  `noUncheckedIndexedAccess`, and `noImplicitOverride`. PAA (already on
  `strict: true`) gained `noUncheckedIndexedAccess` and
  `noImplicitOverride`. Net: one real bug fixed in
  `velocity.service.ts` (un-guarded `sorted[0]` access), and the
  compiler now refuses several whole classes of regression.

### Removed

- Unused `appConfig.onnx.modelRegistryUrl` field. The HTTP-polling
  model registry it once fed was retired in favour of the in-process
  `ModelRegistryService` subscription flow.

## [1.0.0] - 2026-06-07

Initial public release. The platform is a multi-agent fraud-detection stack
with four backend services (RDA, PAA, MLA, FIA) and an operator dashboard
(Sentinel), all self-hosted and decoupled by Kafka.

### Added

- **RDA (Real-Time Detection Agent).** Fastify HTTP API with `POST /v1/predict`
  (sub-5 ms p99 on a developer workstation, ONNX inference, per-segment
  thresholds, idempotency keys, inline reason codes), `/livez` / `/readyz` /
  `/v1/metrics`, and a full `/v1/admin/*` surface. Three-replica deploy
  behind NGINX in `docker-compose.yml`.
- **PAA (Pattern Analysis Agent).** TypeScript Kafka consumer that maintains
  a transaction graph (`graphology`) and velocity windows, batching writes
  to Redis (features) and Postgres (graph metadata every 100 events).
- **MLA (Model Learning Agent).** Python 3.11 drift monitor (F1 + PSI),
  SMOTE-balanced XGBoost retraining, McNemar's test before promotion,
  ONNX export, filesystem-based model registry under
  `mla-service/models/versions/`.
- **FIA (Fraud Investigation Agent).** Python 3.11 LLM service that consumes
  `transactions.blocked`, runs a fine-tuned Phi-3-mini-4k-instruct model
  (fallback to a deterministic rule-based report on LLM failure), writes
  structured investigation reports to Postgres, and exposes
  `POST /v1/reports` and conversational follow-ups via
  `POST /v1/reports/:id/messages`.
- **Sentinel dashboard.** Vite + React 18 SPA covering live decisions,
  transactions, audit log, rules editor, model registry, FIA investigations,
  webhooks, API keys, and user/role administration. Reads use a
  `safe(live, empty-fallback)` pattern; the dashboard never displays
  synthetic data.
- **Authentication and authorization.** API-key auth (`fdk_<prefix>_<secret>`,
  SHA-256-hashed at rest), JWT user auth with bcrypt-hashed users and
  role-based permissions, `requireAuth(...perms)` middleware on every
  `/v1/admin/*` route. SUPER_ADMIN seeded with a one-time random password
  printed at migration time.
- **Rules engine.** JSON-Logic predicate evaluator with PRE / POST stages,
  hot-reloaded from Postgres every 30 s.
- **Model registry.** CANDIDATE → SHADOW → ACTIVE → RETIRED lifecycle,
  per-segment thresholds, hot-swap on activation.
- **Decision audit log.** Every `/v1/predict` writes a row with champion +
  shadow scores, threshold, rule hit, reason codes, feature snapshot.
  Reviewer overrides write back to `groundTruthFraud` so the model does not
  learn from its own past decisions.
- **HMAC-signed webhooks.** SHA-256 over `t.body`, exponential-backoff
  delivery worker, delivery ledger in `webhookDeliveries`. SSRF guards
  reject private IP ranges and non-HTTPS schemes.
- **Idempotency.** `Idempotency-Key` header on `/v1/predict`, keyed against
  `(tenantId, apiKeyId, key, requestHash)`. Replay returns the cached
  response with `Idempotency-Replay: true`. Body divergence returns 422.
- **Resilience.** `opossum` circuit breakers around Redis feature lookup
  and ONNX inference. On breaker open, predictions still succeed against
  default features.
- **Observability.** Prometheus metrics under `/v1/metrics`,
  Grafana dashboard, structured pino logs with sensitive-field redaction.
- **Reason codes.** Lightweight feature-deviation explainer on every
  prediction (e.g. `AMOUNT_HIGH`, `VELOCITY_24H`, `PAGERANK`). For deep
  reasoning use the FIA report endpoints.
- **Feature catalogue.** Declarative `models/feature-catalog.v1.json` (64
  base features across 9 categories) loaded by both RDA and MLA. Adopters
  add their own features via `models/feature-catalog.adopter.json`.
- **Replay CLI.** `scripts/replay.ts` runs candidate models against the
  live audit log for offline evaluation before promotion.

### Security

- Pre-launch hardening pass: CORS allowlist via `SENTINEL_CORS_ORIGINS`,
  per-IP rate limit on `/v1/auth/login`, JWT algorithm / issuer / audience
  pinning, dummy bcrypt for unknown users (constant-time login),
  webhook SSRF guards, idempotency race protection, FIA HTTP API
  authentication, prompt-injection guards on FIA inputs, MLA model loader
  switched from `pickle` to XGBoost JSON format, removal of `useragent`
  package (replaced with `ua-parser-js`).
