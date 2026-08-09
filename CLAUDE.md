# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a polyglot monorepo with **four independent backend services** that share PostgreSQL/Redis/Kafka infrastructure, plus a separate frontend SPA. Each service has its own dependencies and build:

- **Root (`src/`)** — RDA (Real-Time Detection Agent), TypeScript/Fastify HTTP API. Owns the `package.json` at the repo root, the Knex migrations under `src/database/migrations/`, and the shared ONNX model under `models/`.
- **`paa-service/`** — PAA (Pattern Analysis Agent), TypeScript Kafka consumer worker. Has its own `package.json`, `tsconfig.json`, and `node_modules`. Not invoked from the root scripts.
- **`mla-service/`** — MLA (Model Learning Agent), Python 3.11 service. Has its own `requirements.txt` and `venv`. Trains XGBoost → ONNX models that are deployed by copying into `models/fraud_model.onnx` for RDA.
- **`fia-service/`** — FIA (Fraud Investigation Agent), Python 3.11 service. Consumes the `transactions.blocked` Kafka topic, runs a fine-tuned Phi-3-mini-4k-instruct LLM, and writes structured reports to PostgreSQL `investigationReports`. Strictly async — never on the RDA authorization path.
- **`frontend/`** — Sentinel operator dashboard, Vite + React 18 SPA. Has its own `package.json` and `node_modules`. Not invoked from the root scripts. Talks to RDA `/v1/admin/*` and FIA `/v1/reports*`; when those services are unreachable every read returns an empty fallback and the SPA shows a persistent OFFLINE banner — no synthetic data. The old `mock.js` seed and `sentinel.useMock` override were removed in May 2026.

RDA is the only producer. PAA and MLA consume `transactions.completed`; FIA consumes `transactions.blocked` (published by RDA only when the decision is `DECLINE`). All four services share the same Postgres `fraud_db`.

## Common Commands

### RDA (root)
```bash
npm run start:dev          # nodemon hot-reload
npm run build              # tsc; postbuild copies *.yaml into dist/
npm run lint               # eslint over .ts
npm run test               # jest --runInBand --passWithNoTests
npx jest path/to/file.test.ts   # single test file
npx jest -t "test name"         # single test by name
npm run db:migrate         # knex migrate:latest (uses dotenv)
npm run db:migrate:make -- name_of_migration
npm run db:migrate:rollback
```

### PAA (`paa-service/`)
PAA has its own deps and tsconfig — `cd paa-service` first. Same `start:dev` / `build` / `lint` / `test` script names. The root `npm install` does **not** install PAA deps.

### FIA (`fia-service/`)
```bash
cd fia-service && source .venv/bin/activate     # NOTE: .venv (FIA), not venv (MLA)
python -m src.main                              # consume + generate reports
```
Health: `:9094/livez`, `:9094/readyz`, `:9094/stats`. The first run downloads ~7.6 GB of Phi-3-mini-4k-instruct weights to `~/.cache/huggingface`. Set `FIA_FALLBACK_ON_LLM_FAILURE=true` (default) to degrade gracefully to a deterministic rule-based report when the LLM cannot load — the pipeline still produces parseable rows. Device selection: `LLM_DEVICE=auto` picks CUDA → MPS → CPU; on Apple Silicon expect ~45 s model load and a one-time ~6–10 min MPS kernel compilation on the first generation, then ~40–90 s per report steady-state.

### MLA (`mla-service/`)
```bash
cd mla-service && source venv/bin/activate
python -m src.main                          # start drift-monitoring loop
python -m src.main --train                  # force retrain on startup
python scripts/train_initial_model.py       # cold-start training
python scripts/train_initial_model.py --samples 10000 --skip-registry
pytest                                      # all tests
pytest tests/test_onnx_conversion.py -v     # single file
```
After training, deploy the model to RDA with `cp models/fraud_model_v1.0.onnx ../models/fraud_model.onnx`.

### Frontend (`frontend/`)
The Sentinel dashboard has its own deps and build — `cd frontend` first. The root `npm install` does **not** install frontend deps.
```bash
cd frontend && npm install
npm run dev                                  # vite dev server on :5173
npm run build                                # production bundle into dist/
npm test                                     # vitest run (jsdom + Testing Library)
npm test -- tests/sidebar.test.jsx           # single file
```
The dev server proxies `/v1/*` → `VITE_RDA_URL` (default `http://localhost:3000`) and `/fia/*` → `VITE_FIA_URL` (default `http://localhost:9094`, prefix stripped). Auth is read from `localStorage` at request time — `sentinel.jwt` becomes `Authorization: Bearer …` (the user JWT from `POST /v1/auth/login`), `sentinel.apiKey` becomes `X-Api-Key`. See [`docs/FRONTEND.md`](docs/FRONTEND.md) for the full reference.

### Infrastructure
```bash
docker compose up -d redis postgres kafka zookeeper                          # infra only
docker compose -f docker-compose.yml -f docker-compose.dev.yml up rda-dev paa-dev --build   # dev with hot-reload
docker compose up --build                                                    # full prod stack (3× RDA, 1× PAA singleton, NGINX, Prometheus, Grafana)
```

Postgres in Docker listens on **5433** (not 5432) to avoid host conflicts.

## Architecture Notes That Aren't Obvious from One File

### Path aliases differ per service
The root and PAA both use TS path aliases but they map to different roots:
- Root: `@config/*` → `src/config/*`, `@shared/*` → `src/shared/*`, `@utils/*` → `src/shared/utils/*`
- PAA: `@config/*` → `paa-service/src/config/*`, `@services/*` → `paa-service/src/services/*`, `@utils/*` → `paa-service/src/utils/*`

Both rely on `module-alias` at runtime (resolving against `dist/`) and on the `paths` config in their respective `tsconfig.json` at compile time. Jest's `moduleNameMapper` mirrors this — when adding a new alias, update both tsconfig and jest.config.

### DI container
Both TS services use `tsyringe` with `reflect-metadata` imported as the very first line of the entry point. Services are `@injectable()` and resolved via `container.resolve(...)`. `KafkaProducer` is resolved at startup in `src/server.ts` and connection failure is non-fatal (logs warn, retries on first publish).

### Real-time path (RDA) vs async path (PAA)
RDA's `predict` flow is: Redis feature lookup → ONNX inference → Kafka publish. **Features in Redis are stale until PAA writes them.** On Redis cache miss, RDA falls back to default features and logs a degraded-accuracy warning — this is expected behavior, not a bug.

PAA is the writer: it consumes `transactions.completed`, updates an in-memory transaction graph (`graphology`) and velocity windows, then queues batched writes to Redis and Postgres. Graph metadata is snapshotted for both sender and receiver on every event into a Map keyed by `userId`, then bulk-upserted to Postgres on the standard batch flush (size 100 / 10 s) — the Map dedupes hot users so Postgres pressure tracks unique-user rate, not event rate. Redis writes feed the next RDA prediction.

**PAA is a singleton — do not scale it.** The graph and velocity state live in process memory. A second member in the `pattern-analysis` consumer group splits the partition assignment, so each replica runs PageRank/Louvain on a partial graph and rings whose members hash to different partitions become invisible. The worker logs an ERROR and the `paa_group_members` Prometheus gauge exceeds 1 if a second instance ever joins the group.

### Blocked-transaction investigation path
When `PredictService` returns `decision === "DECLINE"`, RDA publishes the same `TransactionEvent` to **two** topics fire-and-forget: the primary `transactions.completed` (consumed by PAA + MLA, partitioned by `sender_id` for per-user ordering) and `transactions.blocked` (consumed only by FIA, partitioned by `transaction_id` so a single high-fraud sender does not pin all FIA work to one partition). The dual publish is intentional — FIA runs at LLM-inference latencies (seconds) and must never share a queue with PAA's millisecond pipeline.

`KafkaProducer.publishAsync(event, topic?, partitionKey?)` is the entry point. The LevelDB disk buffer wraps each entry as `{ v: 2, topic, partitionKey, event }` so flushed events replay to the original topic with the original partition assignment. Legacy raw entries (pre-refactor) fall back to the primary topic with `sender_id` keying. `flushBuffer` continues past per-entry failures — a stuck entry on one topic must not block flush progress on others.

FIA-side idempotency: `investigationReports.transactionId` is UNIQUE and the writer uses `INSERT ... ON CONFLICT DO NOTHING`. The Kafka consumer commits offsets **per-partition** (never `consumer.commit()` with no args, which would advance offsets across partitions). LLM generation runs synchronously in the message handler, so the consumer is configured with `max_poll_records=1` and `max_poll_interval_ms=600000` to prevent rebalances during a slow LLM call. Poison messages are bounded by an in-memory retry counter (`MAX_RETRIES=3`); after that the offset is committed and the failure is logged loudly so a true bad message cannot wedge a partition forever.

### MLA closes the loop offline
MLA monitors F1-score and PSI on the `amount` feature (thresholds: `DRIFT_F1_THRESHOLD=0.92`, `DRIFT_PSI_THRESHOLD=0.25`). On drift it retrains XGBoost with SMOTE, runs McNemar's test against the current model, and only deploys if the improvement is statistically significant. Output is `.onnx` + `_scaler.npz`; the scaler must be loaded alongside the model.

### Resilience
RDA wraps Redis feature retrieval and ONNX inference in `opossum` circuit breakers (see `src/shared/circuit-breaker/`). When breakers open, predictions still succeed but use defaults — design for graceful degradation, not failure.

### Health endpoints
- RDA: `GET /livez`, `GET /readyz`, predict at `POST /v1/predict`, metrics at `GET /v1/metrics` (route version is `/v1`, **not** `/api/v1`).
- PAA: standalone HTTP server on `METRICS_PORT` (default 9090) exposing `/livez`, `/readyz`, `/metrics`, `/stats`. Defined inline in `paa-service/src/worker.ts` — not a Fastify app.
- FIA: HTTP server on `METRICS_PORT` (default 9094) exposing `/livez`, `/readyz`, `/stats` (counters: processed, duplicates, failed, dropped_poison, in_flight_retries, llm_model). Defined inline in `fia-service/src/main.py` — not a Fastify/Flask app.

### Frontend dashboard
The Sentinel SPA under `frontend/` ports the Claude Design handoff into ES-module React. Two non-obvious patterns matter when editing it:

- **`safe()` fallback wrapper.** Every read in `frontend/src/api/client.js` is wrapped: `safe(() => fetch(...), () => [])`. The fallback is always an empty value (`[]`, `{ rows: [], total: 0 }`, `null`) — no `mock.js`, no synthetic rows. When the backend is offline or 401s, the call returns that empty fallback and the page renders an empty state; `app.jsx` flips a persistent `OFFLINE` banner. Write calls (issue key, save rule, …) do **not** use `safe` — they `try` the real call, catch failures locally, surface a toast, and leave the form in its previous state so the operator can retry. New endpoints should follow the same split: reads via `safe`+empty-fallback, writes try-locally-toast.
- **Auth lives in `localStorage`, read per-request.** `adminHeaders()` and `apiHeaders()` in `client.js` re-read `sentinel.jwt` / `sentinel.apiKey` on each call. The JWT is obtained via `POST /v1/auth/login` and authenticates identity only — the server resolves permissions from Postgres per request through a 30 s cache, so role changes and user deactivation apply to live sessions within that window (see `docs/AUTHZ.md`). `RDA_REQUIRE_API_KEY=true` on the backend will 401 all predict calls until `sentinel.apiKey` is set.

The dashboard never sits on the prediction hot path: it issues admin reads and rare writes only. Adding a new page only needs three touch points: a new file under `frontend/src/pages/`, the route id in `loadRoute()` in `frontend/src/app.jsx`, and a `Sidebar` entry in `frontend/src/components/shell.jsx`.

## ONNX Compatibility (MLA only)

XGBoost → ONNX conversion is broken in newer onnxmltools/onnx releases. `mla-service/requirements.txt` pins:
```
onnx==1.13.0
onnxmltools==1.10.0
onnxconverter-common==1.12.0
```
If you see `TypeError: Field onnx.AttributeProto.ints: Expected an int, got a boolean`, reinstall these pinned versions. Do not bump them without testing the full training → ONNX → RDA inference path end-to-end.

## Database

- Single Postgres database `fraud_db`, owned by RDA's Knex migrations under `src/database/migrations/`. PAA and MLA read/write the same tables but do **not** own migrations — schema changes go through the root.
- The `knexfile.js` exposes `primary` and `secondary` pool configs (read replica via `REPLICA_DB_*` env vars, falls back to primary if unset).
- Training requires non-null `fraudLabel` values in the `transactions` table. If absent, MLA's training script falls back to synthetic data (logged as a warning — fine for dev, not for production results).

## Adoption Features (added in 2026-05 revision)

These extend RDA without changing the real-time hot path. They all live
under `src/shared/` so they can be reused by PAA or future workers.

- **API-key auth (`src/shared/auth/`)** — `ApiKeyService` issues `fdk_<prefix>_<secret>`
  tokens, persists only the SHA-256 hash, caches verification for 30 s. The
  `apiKeyMiddleware` plugs into Fastify `preHandler`; `RDA_REQUIRE_API_KEY=true`
  flips the predict endpoint from open to authenticated.
- **User auth + RBAC (`src/shared/authz/`)** — bcrypt-hashed users, roles
  with permission arrays, JWT sessions. Permission catalogue is
  **code-defined** in `permissions.ts` (no migration to add a new code).
  Migration seeds `SUPER_ADMIN` + `admin/admin@fraudit`. The
  `requireAuth(...perms)` middleware (`src/shared/middlewares/require-auth.middleware.ts`)
  guards every `/v1/admin/*` route; the static `RDA_ADMIN_TOKEN` was
  retired in 2026-05.
- **Rules engine (`src/shared/rules/`)** — JSON-Logic-style evaluator (no
  arithmetic, just predicates / combinators / `in` / `var`). Rules are
  hot-reloaded from Postgres every `RULES_RELOAD_INTERVAL_MS` (30 s default).
  `stage` is `PRE` (short-circuits ML) or `POST` (overrides ML). Two seeds
  ship by default: `01_demo_rules.ts` (PRE rules used by the demo dataset)
  and `03_fatf_rule_pack.ts` (FATF: structuring, VPN+amount, high-risk
  corridor TRANSFER, ATO signature, untrusted device + amount — NGN-tuned
  defaults that adopters should review per-market).
- **Model registry (`src/shared/models/model-registry.service.ts`)** — stores
  `modelVersions` and `segmentThresholds`; resolves `(segment) → (champion,
  shadow, threshold)` for each request. Status transitions: CANDIDATE →
  SHADOW → ACTIVE → RETIRED. The ONNX session itself is still loaded by
  `OnnxService`; the registry is metadata + threshold routing only. Per-
  transaction-type threshold defaults (CASH_OUT=0.70, TRANSFER=0.30,
  PAYMENT=0.50, DEBIT=0.50, CASH_IN=0.50) are seeded via
  `02_segment_thresholds.ts` once an ACTIVE model is registered. Lookup
  uses `request.segment ?? request.transaction_type`.
- **Decision audit log (`src/shared/audit/`)** — every `/v1/predict` writes a
  row to `decisionAuditLog` with model versions, scores, threshold, rule hit,
  reason codes, feature snapshot, and reviewer fields. Audit-log failures
  must never break the decision path (the service swallows DB errors).
- **Reason codes (`src/shared/onnx/reason-codes.ts`)** — lightweight
  feature-deviation explainer for the 12 named feature positions. Cheap
  enough to compute on every prediction. For deep narrative reasoning, use
  the FIA endpoints (`POST /v1/reports`, `/messages`).
- **Webhooks (`src/shared/webhooks/`)** — HMAC-signed POST with exponential
  backoff. `WebhookService.publish(event, payload, tenantId)` enqueues
  rows in `webhookDeliveries`; the in-process worker (started from
  `server.ts`) drains pending rows every `WEBHOOK_WORKER_INTERVAL_MS`.
- **Idempotency (`src/shared/idempotency/`)** — `Idempotency-Key` header on
  `/v1/predict` is keyed against `(tenantId, key, requestHash)`. Replay
  returns the cached response with `Idempotency-Replay: true`. Body
  divergence on the same key returns 422.
- **Training-data ingest (`src/v1/modules/training/`)** — adopter CSVs
  enter the system through either `POST /v1/admin/training/import`
  (file:// source for ops-driven imports) or the Sentinel chunked-upload
  protocol (`upload/init`, `chunk`, `complete`, `abandon`). Rows land in
  `transactionsStaging` keyed by `jobId`. `POST /v1/admin/training/import/
  :jobId/promote` upserts them into `transactions` with
  `groundTruthSource = 'training_import'`, then `POST /mla/v1/admin/retrain`
  kicks off a retrain. New tables: `trainingJobs`, `trainingUploads`,
  `transactionsStaging`. See `docs/ADOPTER_TRAINING.md`.
- **Score calibration (MLA, `mla-service/src/training/calibration.py`)** —
  XGBoost saturates near 0.0/1.0; we fit
  `sklearn.IsotonicRegression` on a held-out 10% calibration split and
  persist the calibrator alongside the model. `meta.json` and
  `modelVersions.brierScore` track the calibrated Brier; uncalibrated
  is logged for the regression comparison. Calibration is loaded on
  every retrain; RDA still reads only the ONNX score (the calibration
  bakes into the deployed booster's score distribution).
- **Configurable training mode (`mlaSettings.trainingMode`)** — operators
  pick `FRESH` (current behaviour, train from scratch) or `CONTINUED`
  (seed from current production model via XGBoost `xgb_model=`, add
  `continuedTreesPerRound` trees). Setting persists via
  `PUT /mla/v1/admin/drift-config`. MLA reads it at retrain start;
  in-flight runs keep their loaded mode.

FIA gained an HTTP API on `:9094`: `POST /v1/reports` (on-demand reports
for any transaction, idempotent by `transactionId`), `POST /v1/reports/:id/messages`
(conversational follow-ups persisted in `investigationConversations`),
`GET /v1/reports[/:id]` (list / read).

## Feature catalogue (replaces the legacy 434-dim prototype pipeline)

Features are now **declaratively contracted** in `models/feature-catalog.v1.json` — 64 base features across 9 categories (velocity / pair / graph / transaction / identity / receiver / geographic / device / calendar). Adopters add their own features via `models/feature-catalog.adopter.json` overlay using a small algebra of compute ops (`from_field`, `equals`, `is_one_of`, `ratio`, `lookup`, `numeric_bucket`, `bool_and/or`, `from_redis`). See `docs/FEATURES.md`.

Both RDA (TS — `src/shared/features/`) and MLA (Python — `mla-service/src/features/`) load the same JSON catalogue and validate identical invariants. `feature_schema_version` is baked into every model's `meta.json` and enforced at load time by `OnnxService` — a model trained against a different overlay is **refused** rather than silently misaligned. `MODEL_INPUT_DIMENSION` env enables pad-to-fit during the brief Phase-2/Phase-3 transition where RDA produces 64-dim but the deployed model still expects more.

The previous "PROTOTYPE MODE: USING PLACEHOLDER FEATURES" warnings and 411-zero-padding have been removed. Training and inference dimensions now match exactly.

## Reference Performance (single developer workstation, Apple Silicon)

Orientation values, not SLA targets. Re-measure on your own hardware.

**Two benchmarking traps in this codebase produce confidently-wrong fast numbers — read this before quoting any p99.**

1. **NGINX rate limit.** `nginx/nginx.conf` declares `limit_req zone=api_limit:10m rate=100r/s burst=50` on `/v1/predict`. From a single benchmark host (one source IP), anything above ~150 RPS is rejected with HTTP 503 — NGINX returns the response without forwarding upstream (`rt=0.000 uct="-"` in the access log). A naïve high-RPS bench measures NGINX's reject latency, not the decision path.
2. **Idempotency duplicate short-circuit.** When a request's `transaction_id` matches one already reserved, `PredictService.executePrediction` returns `{ kind: "duplicate" }` and the controller responds 409 without running the model. A bench that posts a single body to every request measures the duplicate-rejection path, which is much faster than the real predict pipeline.

To measure honestly: unique `transaction_id` per request, multi-IP source or temporarily raised rate-limit, and **assert every response is HTTP 200 before computing percentiles**.

**Measured values** (single RDA replica, direct port 3000 to bypass NGINX, unique `transaction_id` per request, all 200 OK):

- ONNX model only (deployed PaySim model, 122 KB, batch=1): p50=0.010 ms, p99=0.049 ms.
- RDA `/v1/predict`, single client, uncontended: p99 ≈ 6 ms (idempotency reservation + audit enqueue are now on the hot path; the earlier 4 ms figure predates those two stages).
- RDA `/v1/predict`, 16 concurrent, 5,000 trials: mean 35 ms, p50=43 ms, p95=140 ms, **p99=295 ms**, p999=3.3 s, ~237 RPS. Per-stage means: `feature_load` 19 ms, `inference` 16 ms — both stages an order of magnitude above their uncontended cost because Node's event loop is serialising async resolutions under contention. The non-ML stages (rules, reason codes, audit_enqueue) stay sub-1 ms.
- IEEE-CIS XGBoost training: 683,852 train / 118,108 test in 27.67 s; held-out F1=0.554, AUC=0.911.
- FIA (Phi-3-mini, MPS, fp16): ~46 s LLM load, ~6–10 min one-time MPS warmup, then ~40–90 s per report. Idempotency guard verified end-to-end.

The 295 ms p99 number is the current honest baseline at meaningful concurrency on this hardware. Driving it down toward the uncontended 6 ms is open work — request admission control at the predict route, hot-path object-allocation cleanup, possibly cluster-mode workers per container, and a benchmark host separate from the server are the levers worth trying next.
