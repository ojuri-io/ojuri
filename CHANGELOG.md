# Changelog

All notable changes to Ojuri will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  and the two binding ceilings (~500 TPS CPU, ~1M nodes memory) with
  a profile-by-profile sizing table from demo through Tier-1.

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
  running >500 TPS will eventually want the externalized-graph
  deployment profile (separate work) instead of scaling PAA.
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
