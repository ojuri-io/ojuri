# Fraud Detection System Architecture

## Overview

This system is a polyglot monorepo of **four independently deployable services** that share PostgreSQL, Redis and Apache Kafka. The split keeps the synchronous fraud-decision path (RDA) decoupled from the slower analytical, learning and investigation paths (PAA, MLA, FIA), so the system meets a millisecond-scale decision SLA while still benefiting from heavy graph analysis and Large Language Model–based case-file generation.

```
                                ┌──────────────────────────────────────┐
                                │         Mobile Money Client          │
                                └───────────────────┬──────────────────┘
                                                    │ POST /v1/predict
                                                    ▼
            ┌─────────────────────────────────────────────────────────────────┐
            │                       NGINX (load balancer)                     │
            └─────────────────────┬─────────────┬─────────────┬───────────────┘
                                  ▼             ▼             ▼
                              ┌───────┐     ┌───────┐     ┌───────┐
                              │ RDA-1 │     │ RDA-2 │     │ RDA-3 │
                              └───┬───┘     └───┬───┘     └───┬───┘
                                  │             │             │
                                  └─────────────┼─────────────┘
                                                ▼
                ┌───────────────┬─────────────────────────────┐
                │               │                             │
                ▼               ▼                             ▼
            ┌───────┐    ┌──────────────┐               ┌──────────┐
            │ Redis │    │ Apache Kafka │               │ Postgres │
            └───────┘    └──┬────────┬──┘               └────┬─────┘
                ▲           │        │                       ▲
                │           │        │                       │
                │     ┌─────┘        └───────┐               │
                │     │ transactions.        │ transactions. │
                │     │ completed            │ blocked       │
                │     ▼ (keyed by sender_id) ▼ (keyed by tx) │
                │  ┌──────────┐         ┌─────────┐          │
                │  │ PAA-1/-2 │         │   FIA   │──────────┤
                │  └────┬─────┘         └────┬────┘  inv-    │
                └──────┘                     │       Reports │
                  refresh                    │               │
                  features                   ▼               │
                                         ┌────────┐          │
                                         │ Phi-3  │          │
                                         │  LLM   │          │
                                         └────────┘          │
                                                             │
                                                       ┌─────┴────────┐
                                                       │     MLA      │
                                                       │ drift+train  │
                                                       └──────┬───────┘
                                                              │ writes models/versions/<v>/
                                                              ▼
                                                       ┌────────────┐
                                                       │ models/    │  ← shared
                                                       │ filesystem │    bind-mount
                                                       │ registry   │    with RDA
                                                       └────────────┘
```

`fraud_db` (a single Postgres database) is owned by RDA's Knex migrations; PAA, MLA and FIA read/write the same tables but do **not** own migrations. Postgres listens on host port `5433`, Redis on `6380`, Kafka on `9092`.

## Components

### 1. RDA — Real-Time Detection Agent

**Purpose:** Synchronous binary fraud decision at transaction time.

**Stack:** TypeScript / Fastify / `tsyringe` DI / ONNX Runtime, located at the repo root under `src/`.

**Endpoint:** `POST /v1/predict` (route version is `/v1`, **not** `/api/v1`).

**Pipeline (`src/v1/modules/rda/services/predict.service.ts`, lines 30–116):**

1. **Feature lookup** — `FeatureService.getFeatures()` reads `features:{senderId}` from Redis behind an `opossum` circuit breaker. On miss or breaker-open it returns a default snapshot and logs a degraded-accuracy warning.
2. **Build vector** — `buildFeatures(catalog, request, redisSnapshot)` resolves every catalogue feature (64 base + adopter overlay) into a single `Float32Array`. Base features have hand-written resolvers; adopter features delegate to the compute-op executor. The vector width comes from the catalogue — no fixed 434 ceiling, no zero-padding placeholders.
3. **Inference** — `OnnxService.predict()` runs the XGBoost model through ONNX Runtime, wrapped in a second circuit breaker. **Fails closed**: on inference failure the breaker returns probability 1.0, i.e. DECLINE. `MODEL_INPUT_DIMENSION` pad-to-fit covers the brief transition when a wider legacy model is still ACTIVE.
4. **Decision** — binary: `fraud = probability >= FRAUD_THRESHOLD` (default 0.65). Decision is `"ACCEPT"` or `"DECLINE"` — there is no `REVIEW` branch.
5. **Publish** — fire-and-forget to Kafka. Always emits to `transactions.completed` keyed by `sender_id`. On `DECLINE` it additionally emits the same event to `transactions.blocked` keyed by `transaction_id`. Neither publish blocks the HTTP response.

**Request:**

```json
{
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "sender_id": "user-001",
  "receiver_id": "user-002",
  "amount": 15000,
  "transaction_type": "TRANSFER",
  "timestamp": 1776520872
}
```

`transaction_type` is enum: `CASH_IN`, `CASH_OUT`, `PAYMENT`, `TRANSFER`, `DEBIT`.

**Response:**

```json
{
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "fraud": false,
  "fraud_probability": 0.2214,
  "decision": "ACCEPT",
  "latency_ms": 1,
  "timestamp": 1776520915274
}
```

**Health & metrics:** `GET /livez`, `GET /readyz` (checks Postgres + Redis), `GET /v1/metrics` (Prometheus).

---

### 2. PAA — Pattern Analysis Agent

**Purpose:** Asynchronous feature computation and pattern detection for the *next* prediction.

**Stack:** TypeScript Kafka consumer worker (`paa-service/src/worker.ts`), not a Fastify app.

**Subscribes to:** `transactions.completed` under consumer group `pattern-analysis` with auto-commit disabled.

**On each message:**

- Updates an in-memory directed transaction graph using the `graphology` library (`graph.service.ts`).
- Records the event into 1-hour, 24-hour and 7-day sliding windows plus a 30-day rolling mean and standard deviation of amount (`velocity.service.ts`).
- Queues a Redis update for that sender so the next RDA call sees fresh features.
- Queues a Postgres write of the transaction row.

**Batched persistence:** Postgres rows flush in batches of 100 (worker.ts, `processedCount % 100`). PageRank over the transaction graph is recomputed on a configurable interval (`GRAPH_UPDATE_INTERVAL`, default 5 min) rather than per-event, since it is O(V·E) and would otherwise dominate the consumer loop.

**Computed features:**

| Category | Metrics |
|---|---|
| Velocity | `velocity_1h`, `velocity_24h`, `velocity_7d`, amount sum & mean per window, 30-day amount mean/stdev |
| Graph    | in-degree, out-degree, unique receivers, unique senders, clustering coefficient, PageRank, hub indicator |

**Health & metrics:** standalone HTTP server on `METRICS_PORT` (default 9090) — `/livez`, `/readyz`, `/metrics`, `/stats`.

---

### 3. MLA — Model Learning Agent

**Purpose:** Offline drift detection, retraining, statistical validation, and ONNX export. Closes the supervised-learning loop.

**Stack:** Python 3.11 (`mla-service/`).

**Drift loop (`mla-service/src/main.py`):** instantiates a `DriftDetector`, `DataLoader`, `DataPreprocessor`, `ModelTrainer`, `ModelValidator`, `ONNXConverter` and a `ModelRegistry`, then polls. Drift fires when:

- F1-score on recent labelled data drops below `DRIFT_F1_THRESHOLD` (0.92), **or**
- Population Stability Index on the `amount` feature exceeds `DRIFT_PSI_THRESHOLD` (0.25). PSI uses 10 histogram bins (`drift_detector.py`, lines 171–222).

**On drift:**

1. Pull labelled training data from Postgres (or fall back to synthetic — fine for dev, not for production results).
2. Retrain XGBoost with `imblearn.SMOTE` oversampling (training split only).
3. Run McNemar's chi-squared test with continuity correction against the currently deployed model (`validator.py`, lines 143–184).
4. Deploy the candidate **only** if the raw F1 improvement ≥ 0.01 **and** the change is significant at α = 0.05.
5. Convert to ONNX (`onnx==1.13.0` / `onnxmltools==1.10.0` — newer versions break XGBoost conversion). Output is `.onnx` + `_scaler.npz` (StandardScaler mean/variance) + `_metadata.json`.
6. Materialise into the filesystem registry under `models/versions/<v>/{model.onnx,model.pkl,scaler.npz,meta.json}` (shared bind-mount with RDA), then POST `/v1/admin/models` and flip to `ACTIVE`. RDA's `OnnxService.onActiveChange` listener hot-swaps the session — no copy step, no restart.

A full retrain on 683,852 IEEE-CIS rows including SMOTE and 5-fold CV completes in ~28 s on a single CPU.

---

### 4. FIA — Fraud Investigation Agent

**Purpose:** Generate analyst-readable investigation reports for declined transactions using a fine-tuned LLM. Strictly async — never on the RDA authorization path.

**Stack:** Python 3.11 (`fia-service/`), HuggingFace Transformers + PyTorch.

**Subscribes to:** `transactions.blocked` under consumer group `fraud-investigation`. The topic is keyed by `transaction_id` (not `sender_id`) so a single attacking sender does not pin all FIA work to one partition.

**Pipeline:**

1. Receive a blocked-transaction event.
2. Render a Phi-3 instruction-format prompt (`fia-service/src/llm/prompt.py`, system role = "senior fraud investigator at a Nigerian mobile money provider").
3. Run `microsoft/Phi-3-mini-4k-instruct` (3.8B params) on Apple MPS (fp16), CUDA, or CPU — auto-selected.
4. Parse the JSON response through a Pydantic schema (`report_schema.py`) with normalisation of common synonyms (`FRAUD` → `FRAUD_CONFIRMED`, `REVIEW` → `MANUAL_REVIEW`).
5. Persist with `INSERT … ON CONFLICT (transactionId) DO NOTHING` (`report_writer.py`) — idempotent against re-delivery.
6. Commit the Kafka offset **per-partition** with `OffsetAndMetadata`, never `consumer.commit()` with no args.

**Operational tuning forced by LLM latency:**

- `max_poll_records = 1` and `max_poll_interval_ms = 600000` (10 min) so a slow generation does not trigger a consumer-group rebalance.
- An in-memory retry counter caps redelivery at `MAX_RETRIES = 3`; after that the offset is committed and the failure is logged loudly so a poison message cannot wedge a partition forever.
- A deterministic `_rule_based_report()` fallback runs when the LLM cannot load or its output cannot be parsed (toggle `FIA_FALLBACK_ON_LLM_FAILURE`, default `true`). Fallback rows are tagged with `-fallback` on `llmModelVersion` so analytics can stratify.

**Output schema:** rows in `investigationReports` carry verdict (`FRAUD_CONFIRMED` / `LIKELY_LEGITIMATE` / `UNCERTAIN`), recommended_action (`BLOCK` / `CONTACT_CUSTOMER` / `MANUAL_REVIEW` / `RELEASE`), agent_confidence, key_indicators (JSONB array), narrative, plus `llmModelVersion` and `promptTemplateVersion` for downstream A/B analysis.

**Health & metrics:** `GET /livez`, `/readyz`, `/stats` on port 9094.

---

## Data Flow

### Real-time path (synchronous, ~1–4 ms p50–p99 from a single client)

```
1. Client                  POST /v1/predict
2. RDA                     Redis GET features:{senderId}      [opossum CB]
3. RDA                     enrich with amount + type encoding
4. RDA                     ONNX inference (XGBoost)           [opossum CB, fail-closed]
5. RDA                     decision = ACCEPT or DECLINE
6. RDA → Client            HTTP 200 (decision + probability)
7. RDA → Kafka             publishAsync(event) to transactions.completed
8. RDA → Kafka  (DECLINE only) publishAsync(event, transactions.blocked, txn_id)
```

### Analytics path (asynchronous)

```
1. PAA consume(transactions.completed)
2. PAA update transaction graph + velocity windows in memory
3. PAA queue Redis update of features:{senderId}            (next RDA call benefits)
4. PAA queue Postgres write of transaction row              (batched, 100 events)
5. PAA every GRAPH_UPDATE_INTERVAL: recompute PageRank
6. PAA commit Kafka offset per-partition
```

### Investigation path (async, seconds per LLM call)

```
1. FIA consume(transactions.blocked)
2. FIA render Phi-3 prompt
3. FIA generate via LLM (or rule-based fallback)
4. FIA parse + Pydantic-validate the JSON output
5. FIA INSERT … ON CONFLICT DO NOTHING into investigationReports
6. FIA commit per-partition offset for THIS partition only
```

### Learning path (offline, periodic)

```
1. MLA pull labelled rows from Postgres (decisionSource = 'ML' only)
2. MLA evaluate deployed model: F1 + PSI(amount)
3. If drift: retrain XGBoost + SMOTE
4. McNemar's test vs deployed model
5. If significant improvement: ONNX export to models/versions/<version>/
6. MLA POSTs /v1/admin/models (register CANDIDATE) and
   /v1/admin/models/<version>/status (ACTIVE) on RDA
7. RDA's ModelRegistryService fires its onActiveChange listener →
   OnnxService loads the new ONNX bytes from models/versions/<version>/
   and atomically replaces the in-process session. No restart needed.
```

Filesystem layout (shared bind-mount; RDA reads, MLA writes):

```
models/
├── fraud_model.onnx           # legacy MODEL_PATH default — kept for cold-start
└── versions/
    ├── v1.0.0/{model.onnx, model.pkl, scaler.npz, meta.json}
    ├── v1.1.0/…
    └── v1.2.0/…
```

The MinIO step that earlier revisions documented has been retired
from the self-hosted distribution — adopters who want object storage
can fork and reintroduce it without changing this schema.

---

## Infrastructure

| Service     | Internal Port | Host Port | Purpose |
|-------------|---------------|-----------|---------|
| RDA         | 3000          | 3000      | REST API |
| PAA         | 9090          | 9090/9091 | Metrics + health |
| FIA         | 9094          | 9094      | Health + stats |
| PostgreSQL  | 5432          | **5433**  | Avoids the local 5432 |
| Redis       | 6379          | **6380**  | Avoids the local 6379 |
| Kafka       | 9092          | 9092      | Event bus |
| Zookeeper   | 2181          | —         | Kafka coordination |
| Prometheus  | 9090          | 9099      | Metrics scrape |
| Grafana     | 3000          | 3001      | Dashboards |

Model registry: filesystem-backed under `models/versions/`, shared between RDA and MLA via bind-mount. See `docs/MODEL-REGISTRY.md`.

### Spinning up the system

```bash
# Infra only (recommended for development)
docker compose up -d redis postgres kafka zookeeper

# Run migrations
npm run db:migrate

# Train an initial model (cold start)
cd mla-service && source venv/bin/activate
python scripts/train_initial_model.py --samples 5000 --skip-registry
cp models/fraud_model_v1.0.onnx ../models/fraud_model.onnx
cd ..

# Run RDA + PAA locally with hot-reload
npm run start:dev                                  # terminal 1
(cd paa-service && METRICS_PORT=9091 npm run start:dev)  # terminal 2

# Run FIA (requires ~7.6 GB Phi-3 weights on first launch)
(cd fia-service && source .venv/bin/activate && python -m src.main)  # terminal 3
```

The shipped `docker-compose.yml` runs the full production stack (3× RDA, 2× PAA, NGINX, Prometheus, Grafana). FIA is not yet bundled into compose because the LLM weights and accelerator selection are environment-specific.

---

## Database Schema

Owned by Knex migrations under `src/database/migrations/`:

- `transactions` — fraud-scored events. `fraudLabel` is the upstream "system decided this was fraud" signal; `groundTruthFraud` is the verified label (populated by reviewer overrides, chargebacks, customer reports). MLA's training query prefers `groundTruthFraud` via `COALESCE`, falling back to `fraudLabel` for unlabelled rows.
- `fraudAlerts` — high-risk transaction summaries.
- `graphMetadata` — PAA-emitted network features, persisted every 100 events.
- `velocitySnapshots` — periodic snapshots of velocity windows.
- `modelVersions` / `segmentThresholds` — model-version registry rows + per-segment threshold routing.
- `decisionAuditLog` — one row per `/v1/predict` with model versions, scores, threshold, rule hit, reason codes, feature snapshot, reviewer fields.
- `investigationReports` — FIA output. **`transactionId` is UNIQUE** — required for the idempotency guard on FIA writes.
- `auditTrails` — system audit logs.
- `deadLetterQueue` — failed message retry queue.

`knexfile.js` exposes `primary` and `secondary` pool configs. The secondary points at a read replica via `REPLICA_DB_*` env vars (falls back to primary if unset).

---

## Key Design Decisions

1. **Binary decision, not three-way.** `predict.service.ts` line 70 is `decision = fraud ? "DECLINE" : "ACCEPT"`. There is no REVIEW state — earlier docs claiming a tri-level threshold are stale.
2. **Dual Kafka publish on DECLINE.** RDA is the only producer; on DECLINE it fires the same event to two topics with two different partition keys. This keeps FIA's seconds-per-call LLM workload off PAA's millisecond pipeline.
3. **Fire-and-forget Kafka publishes with a LevelDB disk buffer.** Each buffered entry is wrapped as `{ v: 2, topic, partitionKey, event }` so flushed events replay to the original topic on the original partition. RDA's HTTP response never waits on Kafka.
4. **Two layers of circuit breakers in RDA.** Redis lookup falls back to default features (degraded accuracy, but service stays up). ONNX inference fails closed (returns probability 1.0 → DECLINE) so a model-runtime crash blocks rather than approves transactions.
5. **Per-partition Kafka offset commits in FIA.** A blanket `consumer.commit()` would advance offsets across partitions even for messages that were never processed; FIA explicitly commits with `OffsetAndMetadata` for the specific TopicPartition only.
6. **MPS warmup is per-process.** PyTorch's MPS backend lazily JIT-compiles Metal Performance Shader kernels for each new input shape. The first FIA generation in a new process pays a one-time ~6–10 minute compilation cost; subsequent generations stabilise around 40–90 s. In production the consumer is kept warm by the message stream.
7. **Pinned ONNX toolchain.** XGBoost-to-ONNX conversion breaks on newer `onnxmltools` releases with a `Field onnx.AttributeProto.ints` type-mismatch. The pinned versions in `mla-service/requirements.txt` are deliberately old and should not be bumped without testing the full training → ONNX → RDA inference path.

---

## Reference Performance

The numbers below were measured on a single developer workstation (Apple Silicon MacBook Pro, infra in Docker on the same host) and should be treated as orientation values, not SLA targets. Re-measure on your own hardware before relying on them.

| Path | Statistic | Value |
|---|---|---|
| ONNX inference, batch=1 (CPUExecutionProvider) | p50 / p99 | 0.010 ms / 0.049 ms |
| ONNX inference, batch=128 | throughput | ~1.18 M predictions/s |
| RDA `POST /v1/predict`, single client (3,000 trials) | mean / p99 | 1.36 ms / 4.06 ms |
| RDA throughput at peak (16 connections) | req/s | ~3,146 |
| RDA saturation (64 connections) | p99 / req/s | 297 ms / ~1,832 |
| MLA full retrain on IEEE-CIS (683k train + 5-fold CV) | wall time | 27.67 s |
| Deployed model on held-out IEEE-CIS test | F1 / AUC-ROC / Precision / Recall | 0.554 / 0.911 / 0.841 / 0.414 |
| Phi-3 model load on Apple MPS | wall time | ~46 s |
| Phi-3 first generation (one-time MPS warmup) | wall time | ~6–10 min |
| Phi-3 steady-state generation | wall time | ~40–90 s/report |

---

## Monitoring

### Prometheus metrics

**RDA (`:3000/v1/metrics`):**
- `fraud_predictions_total{decision}`
- `fraud_prediction_latency_ms`
- `onnx_inference_duration_ms`
- Redis & ONNX circuit-breaker state gauges.

**PAA (`:9090/metrics`):**
- `paa_transactions_processed_total`
- `paa_processing_latency_ms`
- `paa_kafka_lag`
- `paa_graph_nodes`, `paa_graph_edges`

**FIA (`:9094/stats`):** JSON counters — `processed`, `duplicates`, `failed`, `dropped_poison`, `in_flight_retries`, `llm_model`.

---

## Known Limitations

1. **Feature catalogue v1 ships at 64 features.** Base coverage spans 9 categories (velocity, pair, graph, transaction, identity, receiver, geographic, device, calendar). Adopters extend via the JSON overlay — `models/feature-catalog.adopter.json` — without touching code. PAA still computes per-user signals; the legacy 434-dim zero-padding and "PROTOTYPE MODE" warning have been removed. See `docs/FEATURES.md` for the catalogue and compute-op reference.
2. **Two model artefacts exist.** `models/fraud_model.onnx` is the deployed PaySim-trained model whose F1 = 0.999 numbers are inflated by balance-delta label leakage. `mla-service/models/fraud_model_v1.0.onnx` is the IEEE-CIS-trained candidate (F1 = 0.554, AUC = 0.911) — the more honest signal.
3. **FIA is not yet in `docker-compose.yml`.** The LLM weights and accelerator selection are environment-specific; FIA runs from its own Python venv on the host today.
4. **Single-host benchmarks.** The performance numbers above describe one RDA replica on a developer workstation. The reference deployment runs three replicas behind NGINX; multi-host load testing is left to adopters who can size for their own traffic profile.
