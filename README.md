# Multi-Agent Fraud Detection

Open-source, self-hostable real-time fraud detection platform built as four
cooperating microservices around shared PostgreSQL / Redis / Kafka infrastructure.
Released under the MIT License — see [`LICENSE`](LICENSE).

> **What's new in this revision** — see [`IMPROVEMENTS.md`](IMPROVEMENTS.md) for
> the full adoption-focused feature list. Highlights: API-key auth, a
> per-decision audit log with inline reason codes, a hot-reloaded rules
> engine, a model registry with shadow / activate / retire, HMAC-signed
> webhooks, idempotency keys, and a conversational FIA HTTP API for the
> investigation UI.
>
> **Per-feature reference docs** live under [`docs/`](docs/README.md):
> [auth](docs/AUTH.md), [audit log](docs/AUDIT.md),
> [reason codes](docs/REASON-CODES.md), [rules](docs/RULES.md),
> [model registry](docs/MODEL-REGISTRY.md), [feature catalogue](docs/FEATURES.md),
> [training](docs/TRAINING.md), [webhooks](docs/WEBHOOKS.md),
> [idempotency](docs/IDEMPOTENCY.md), [FIA API](docs/FIA-API.md).

The four services:

- **RDA (Real-Time Detection Agent)**: HTTP API using Fastify for fraud prediction with ONNX model inference, Redis feature retrieval, and Kafka event publishing
- **PAA (Pattern Analysis Agent)**: Standalone Kafka consumer worker for graph-based network analysis, velocity calculations, and feature engineering
- **MLA (Model Learning Agent)**: Python service for concept drift detection, automated model retraining, and A/B testing deployment
- **FIA (Fraud Investigation Agent)**: Python service that consumes blocked transactions and uses a fine-tuned Phi-3 LLM to generate analyst-readable investigation reports (async, never on the auth path)
- **Sentinel dashboard (`frontend/`)**: Vite + React 18 operator UI built from the Sentinel design handoff. Review queue, transaction detail, rule editor, model registry, audit log, investigations, integrations. Talks to RDA's `/v1/admin/*` and FIA's `/v1/reports*` APIs; falls back to seed data when those services are offline so the UI is always demoable. See [`docs/FRONTEND.md`](docs/FRONTEND.md).

## Architecture

```mermaid
flowchart TB
    Client(["Server-side caller (PSP / wallet / gateway)"])
    Operator(["Operator / Analyst"])
    Subs(["Subscriber endpoints"])

    Client -->|"POST /v1/predict + X-Api-Key + Idempotency-Key"| RDA
    RDA -->|"ACCEPT / DECLINE / REVIEW + reason codes"| Client

    Operator -->|HTTPS| UI

    subgraph FE ["Sentinel Dashboard"]
        UI["Review queue, Rules, Models, Features,<br/>Audit log, Investigations, Users / Roles"]
    end

    UI -.->|"JWT /v1/admin/*"| RDA
    UI -.->|"/v1/reports*"| FIA

    subgraph S1 ["Real-Time Detection Agent (RDA)"]
        RDA["Fastify HTTP API"]
        Rules["Rules Engine<br/>PRE / POST, hot-reload 30s"]
        Builder["Feature Builder<br/>catalogue-driven (64 + N dims)"]
        ONNX["ONNX Runtime<br/>XGBoost, segment thresholds"]
        Reasons["Reason Codes"]
        Audit["Decision Audit"]
        RDA --> Rules
        Rules --> Builder
        Builder --> ONNX
        ONNX --> Reasons
        Reasons --> Audit
    end

    subgraph S2 ["Pattern Analysis Agent (PAA)"]
        PAA["Kafka consumer"]
        Graph["Transaction graph<br/>+ velocity windows"]
        PAA --> Graph
    end

    subgraph S3 ["Model Learning Agent (MLA)"]
        MLA["Drift monitor (F1 + PSI)"]
        Train["XGBoost + SMOTE<br/>McNemar A/B"]
        Conv["ONNX export<br/>+ feature_schema_version"]
        MLA --> Train
        Train --> Conv
    end

    subgraph S4 ["Fraud Investigation Agent (FIA)"]
        FIA["HTTP API + Kafka consumer"]
        LLM["Phi-3-mini-4k (LoRA)<br/>rule-based fallback"]
        FIA --> LLM
    end

    Redis[("Redis<br/>features hash per sender")]
    Kafka[["Apache Kafka"]]
    PG[("PostgreSQL — fraud_db")]
    Models[("models/versions/ on disk<br/>shared bind-mount")]

    Builder <-->|"hgetall catalogue keys"| Redis
    RDA -->|"transactions.completed (key=sender_id)"| Kafka
    RDA -->|"transactions.blocked (DECLINE only, key=transaction_id)"| Kafka
    Audit -->|"decisionAuditLog"| PG

    Kafka -->|"transactions.completed"| PAA
    Kafka -->|"transactions.completed"| MLA
    Kafka -->|"transactions.blocked"| FIA

    Graph -->|"catalogue keys"| Redis
    Graph -->|"graphMetadata, velocitySnapshots"| PG

    MLA <-->|"COALESCE groundTruthFraud, fraudLabel"| PG
    Conv -->|"write model.onnx + meta.json"| Models
    Conv -->|"POST /v1/admin/models then ACTIVE"| RDA
    Models -.->|"onActiveChange hot-swap"| ONNX

    LLM -->|"investigationReports (UNIQUE on transactionId)"| PG

    UI -->|"reviewer override Accept / Decline"| RDA
    Audit -->|"groundTruthFraud (closes the loop)"| PG

    RDA -->|"HMAC-signed webhooks"| Subs

    classDef fiaTone fill:#FAECE7,stroke:#993C1D,stroke-width:2px,color:#4A1B0C
    classDef feTone fill:#E8F0FA,stroke:#1F4E8C,stroke-width:1px,color:#0F2C52
    classDef storeTone fill:#FFF4D1,stroke:#8B6914,stroke-width:1px,color:#5C4500
    class FIA,LLM fiaTone
    class UI feTone
    class Models storeTone
```

**Reading the diagram.** The synchronous path is `Client → RDA → ACCEPT/DECLINE/REVIEW` — everything else is async. RDA publishes every scored event to `transactions.completed` keyed by `sender_id` (consumed by PAA + MLA for per-user ordering) and, on `DECLINE`, additionally to `transactions.blocked` keyed by `transaction_id` (consumed only by FIA — keeps seconds-per-LLM-call latency off PAA's millisecond pipeline). The model registry is filesystem-backed (`models/versions/<v>/`) and shared between RDA and MLA via bind-mount; MLA writes a new version, RDA's `OnnxService` hot-swaps the session via `onActiveChange`. Reviewer overrides in the dashboard write `groundTruthFraud` on the matching transaction row, which MLA prefers via `COALESCE` over the system's own prior decision — that's the loop that prevents the model from learning to reproduce its own past decisions.

## Prerequisites

- Docker Desktop (v20.10+)
- Node.js 18+ (for local development)
- npm 9+

## Quick Start

### 1. Start Infrastructure

```bash
# Start Redis, PostgreSQL, Kafka, and Zookeeper
docker compose up -d redis postgres kafka zookeeper

# Verify services are running
docker compose ps
```

### 2. Run Database Migrations

```bash
npm run db:migrate
```

The migration seeds three roles (`SUPER_ADMIN`, `FRAUD_ANALYST`,
`OPERATIONS`) and a default admin user. Log in with
**`admin / admin@fraudit`** the first time, then change the password
via `PATCH /v1/admin/users/:id`. Full auth model:
[`docs/AUTHZ.md`](docs/AUTHZ.md).

### 3. Start Development Services

**Option A: Run in Docker (with hot-reload)**

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up rda-dev paa-dev --build
```

**Option B: Run Locally (faster hot-reload)**

```bash
# Terminal 1 - Start RDA
npm run start:dev

# Terminal 2 - Start PAA
cd paa-service && npm run start:dev

# Terminal 3 - Start MLA
cd mla-service && source venv/bin/activate && python -m src.main
```

### MLA Initial Setup (first time only)

```bash
cd mla-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Train initial model
python scripts/train_initial_model.py
```

### FIA Initial Setup (first time only)

```bash
cd fia-service
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt              # ~3 GB: torch + transformers + accelerate
cp .env.example .env
PYTHONPATH=. python -m src.main              # first boot downloads Phi-3 weights (~7.6 GB)
```

`LLM_DEVICE=auto` selects CUDA → MPS (Apple Silicon) → CPU in that order.
For wiring tests on a machine without spare GBs, install only the lightweight
deps (`kafka-python sqlalchemy psycopg2-binary pydantic python-dotenv`) and
keep the default `FIA_FALLBACK_ON_LLM_FAILURE=true` — FIA will degrade to a
deterministic rule-based report so the pipeline still produces rows. See
[`fia-service/README.md`](fia-service/README.md) for full details.

### Sentinel Dashboard (frontend)

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The Vite dev server proxies `/v1/*` → RDA (`VITE_RDA_URL`, default
`http://localhost:3000`) and `/fia/*` → FIA (`VITE_FIA_URL`, default
`http://localhost:9094`). Set your admin token and an issued API key in
the browser to enable writes:

```js
// Get a JWT first from POST /v1/auth/login with admin / admin@fraudit.
localStorage.setItem('sentinel.jwt', '<token from /v1/auth/login>');
localStorage.setItem('sentinel.apiKey', 'fdk_…');
```

The dashboard runs against the live API when those services are up
and silently falls back to seed data otherwise — so you can review the
design without booting Postgres / Redis / Kafka / RDA / FIA. Full
reference: [`docs/FRONTEND.md`](docs/FRONTEND.md).

## Environment Configuration

### Main Service (.env)

```env
DB_CLIENT=postgres
DB_DATABASE=fraud_db
DB_HOST=localhost
DB_PASSWORD=postgres
DB_USERNAME=postgres
DB_PORT=5433
DB_URL=postgresql://postgres:postgres@localhost:5433/fraud_db

PORT=3000
APP_NAME=FraudService

REDIS_HOST=localhost
REDIS_PORT=6380          # Docker host port (avoids the local 6379)
REDIS_USERNAME=default
REDIS_PASSWORD=

KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=transactions.completed
KAFKA_BLOCKED_TOPIC=transactions.blocked     # without this, FIA gets nothing

MODEL_PATH=./models/fraud_model.onnx
FRAUD_THRESHOLD=0.65
LOG_LEVEL=debug

# --- Adoption features ---

# Authentication
RDA_REQUIRE_API_KEY=false                    # set true to force X-Api-Key on /v1/predict
AUTH_JWT_SECRET=                             # ≥16-char random string. Required for login & all admin APIs.
AUTH_JWT_TTL_SECONDS=28800                   # session lifetime; default 8h

# Rules + registry refresh
RULES_RELOAD_INTERVAL_MS=30000
MODEL_REGISTRY_REFRESH_MS=30000

# Webhook delivery
WEBHOOK_WORKER_INTERVAL_MS=10000

# Idempotency cache TTL on /v1/predict
IDEMPOTENCY_TTL_MS=86400000                  # 24h
```

### PAA Service (paa-service/.env)

```env
NODE_ENV=development
APP_NAME=fraud-paa-dev
METRICS_PORT=9090

DB_CLIENT=postgres
DB_URL=postgresql://postgres:postgres@localhost:5433/fraud_db

REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_PASSWORD=

KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=transactions.completed
KAFKA_CONSUMER_GROUP=pattern-analysis
KAFKA_CLIENT_ID=paa-dev

LOG_LEVEL=debug
GRAPH_UPDATE_INTERVAL=60000      # PageRank interval, ms
PAGERANK_DAMPING=0.85
BATCH_SIZE=50                    # Postgres batch flush size
MAX_GRAPH_NODES=100000
```

### MLA Service (mla-service/.env)

```env
# Kafka Configuration
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=transactions.completed
KAFKA_CONSUMER_GROUP=model-learning-v2

# MinIO (Optional - for model storage)
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=fraud-models

# Drift Detection Thresholds
DRIFT_F1_THRESHOLD=0.92
DRIFT_PSI_THRESHOLD=0.25
TRAINING_DATA_SIZE=50000
```

### FIA Service (fia-service/.env)

```env
KAFKA_BROKERS=localhost:9092
KAFKA_BLOCKED_TOPIC=transactions.blocked
KAFKA_CONSUMER_GROUP=fraud-investigation
KAFKA_AUTO_OFFSET_RESET=earliest

POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_DB=fraud_db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

# LLM
LLM_MODEL_NAME=microsoft/Phi-3-mini-4k-instruct
LLM_MODEL_PATH=                              # set to a local fine-tuned checkpoint to override LLM_MODEL_NAME
LLM_DEVICE=auto                              # cuda | mps | cpu
LLM_DTYPE=auto                               # float16 | bfloat16 | float32
LLM_MAX_NEW_TOKENS=384
LLM_TEMPERATURE=0.2

PROMPT_TEMPLATE_VERSION=v1
FIA_FALLBACK_ON_LLM_FAILURE=true             # rule-based fallback if LLM unavailable / output unparseable

METRICS_PORT=9094
LOG_LEVEL=INFO
```

The corresponding RDA-side toggle is `KAFKA_BLOCKED_TOPIC=transactions.blocked`
in the root `.env` — without it RDA only publishes to `transactions.completed`
and FIA never receives anything.

## Docker Commands

### Development

```bash
# Start infrastructure only
docker compose up -d redis postgres kafka zookeeper

# Start dev services with hot-reload
docker compose -f docker-compose.yml -f docker-compose.dev.yml up rda-dev paa-dev --build

# Rebuild after code changes
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build rda-dev paa-dev
```

### Production

```bash
# Start full stack (3 RDA replicas, 2 PAA replicas, NGINX, monitoring)
docker compose up --build

# Start specific services
docker compose up -d rda-1 rda-2 rda-3 paa-1 paa-2
```

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f fraud-redis
docker compose logs -f fraud-postgres
docker compose logs -f fraud-kafka

# Dev services
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f rda-dev
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f paa-dev

# Follow both dev services
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f rda-dev paa-dev

# Last 100 lines only
docker compose logs --tail=100
```

### Management

```bash
# Check running containers
docker compose ps

# Stop all services
docker compose down

# Stop and remove volumes (clean slate)
docker compose down -v

# Restart a specific service
docker compose restart fraud-redis
```

## API Endpoints

### RDA Service (http://localhost:3000)

| Method | Endpoint                              | Description                                         |
|--------|---------------------------------------|-----------------------------------------------------|
| GET    | `/`                                   | Service info                                        |
| GET    | `/livez`                              | Liveness probe                                      |
| GET    | `/readyz`                             | Readiness probe (Postgres + Redis)                  |
| POST   | `/v1/predict`                         | Fraud prediction                                    |
| GET    | `/v1/decisions/:transactionId`        | Read the audit row for a transaction                |
| POST   | `/v1/decisions/:auditId/override`     | Human reviewer override (fires `decision.overridden`) |
| GET    | `/v1/review-queue`                    | Newest DECLINE rows awaiting review                 |
| GET    | `/v1/metrics`                         | Prometheus metrics                                  |
| POST   | `/v1/auth/login`                      | User login → JWT (see docs/AUTHZ.md)                |
| POST   | `/v1/auth/logout`                     | Stateless logout (client drops token)               |
| GET    | `/v1/auth/me`                         | Current user + roles + permissions                  |
| GET    | `/v1/admin/permissions`               | List the permission catalogue                       |
| POST   | `/v1/admin/users`                     | Create a new user (perm: `users:create`)            |
| GET    | `/v1/admin/users`                     | List users                                          |
| PATCH  | `/v1/admin/users/:id`                 | Edit user (name / email / password / active)        |
| DELETE | `/v1/admin/users/:id`                 | Delete user                                         |
| POST   | `/v1/admin/users/:id/roles`           | Assign a role to a user                             |
| DELETE | `/v1/admin/users/:id/roles/:roleId`   | Remove a role from a user                           |
| GET    | `/v1/admin/roles`                     | List roles + their permissions                      |
| POST   | `/v1/admin/roles`                     | Create a custom role with picked permissions        |
| PATCH  | `/v1/admin/roles/:id`                 | Edit a custom role (system roles are immutable)     |
| DELETE | `/v1/admin/roles/:id`                 | Delete a custom role                                |
| POST   | `/v1/admin/api-keys`                  | Issue an API key (perm: `api_keys:issue`)           |
| GET    | `/v1/admin/api-keys`                  | List API keys                                       |
| DELETE | `/v1/admin/api-keys/:id`              | Revoke an API key                                   |
| POST   | `/v1/admin/webhooks`                  | Register a webhook subscription                     |
| GET    | `/v1/admin/webhooks`                  | List subscriptions                                  |
| DELETE | `/v1/admin/webhooks/:id`              | Revoke a subscription                               |
| POST   | `/v1/admin/models`                    | Register a model version (CANDIDATE)                |
| GET    | `/v1/admin/models`                    | List models                                         |
| POST   | `/v1/admin/models/:version/status`    | Activate / shadow / retire                          |
| POST   | `/v1/admin/segment-thresholds`        | Set a per-segment threshold                         |
| POST   | `/v1/admin/rules`                     | Create a pre/post rule                              |
| GET    | `/v1/admin/rules`                     | List rules                                          |
| PATCH  | `/v1/admin/rules/:id`                 | Update a rule                                       |
| DELETE | `/v1/admin/rules/:id`                 | Delete a rule                                       |

Admin endpoints (`/v1/admin/*`) require a logged-in user JWT
(`Authorization: Bearer <token>` from `/v1/auth/login`) **and** the
per-route permission code. The seeded `admin / admin@fraudit` user has
the `SUPER_ADMIN` role (all permissions); create real users and
custom roles via the admin API — see [`docs/AUTHZ.md`](docs/AUTHZ.md).
The predict / audit / review-queue endpoints honour `X-Api-Key` (or
`Authorization: Bearer fdk_…`) and apply the per-key rate limit. Set
`RDA_REQUIRE_API_KEY=true` to make predict auth mandatory; the default
is `false` so the existing curl examples still work out of the box.

### Example Requests

```bash
# Health check
curl http://localhost:3000/livez

# Fraud prediction
curl -X POST http://localhost:3000/v1/predict \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: fdk_..." \
  -H "Idempotency-Key: 6e0d6c8e-a7f7-4f1a-94a1-3c8d0a2c0a01" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user123",
    "receiver_id": "user456",
    "amount": 1500.00,
    "transaction_type": "TRANSFER",
    "timestamp": 1713100800,
    "segment": "high_value"
  }'
```

The response now includes inline explanations and routing metadata:

```json
{
  "transaction_id": "550e8400-…",
  "fraud": false,
  "fraud_probability": 0.1842,
  "decision": "ACCEPT",
  "decision_source": "ML",
  "reason_codes": [
    { "code": "AMOUNT_HIGH",  "description": "Transaction amount relative to typical range", "contribution":  0.27, "value": 1500.0 },
    { "code": "VELOCITY_24H", "description": "Transactions in the last 24 hours above baseline", "contribution": -0.05, "value": 4.0 },
    { "code": "PAGERANK",     "description": "Network-centrality score from the transaction graph", "contribution": -0.04, "value": 0.32 }
  ],
  "model_version": "default",
  "threshold": 0.65,
  "audit_id": "f3d7c0bc-…",
  "latency_ms": 3,
  "timestamp": 1713100800123
}
```

On `DECLINE`, RDA additionally publishes the event to `transactions.blocked`
for FIA. When a rule short-circuits the pipeline, the response includes
`decision_source: "PRE_RULE" | "POST_RULE"` and `rule: { id, name, stage }`.

Log in as the seeded admin to get a JWT, then bootstrap an API key:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin@fraudit"}' | jq -r .data.token)

curl -X POST http://localhost:3000/v1/admin/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "name": "prod-1", "rateLimitPerMinute": 1200 }'
```

The response contains the plaintext token exactly once — store it now;
only the SHA-256 hash is persisted.

`tenantId` is optional. The platform is built to be self-hosted, so the
default is a single shared `"default"` tenant — no need to think about
multi-tenancy unless you actually have sub-merchants, sandbox/prod splits,
or business-unit isolation, in which case pass an explicit `tenantId` and
keys / webhooks / idempotency scoping flows from it.

Register a webhook:

```bash
curl -X POST http://localhost:3000/v1/admin/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://acme.example.com/fraud-webhook",
    "events": ["decision.created", "decision.overridden"]
  }'
```

Webhooks are signed with `X-Webhook-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`. Replay-resistance is the
caller's responsibility — compare `t` against your clock skew window.

Create a pre-ML rule (instant blocklist):

```bash
curl -X POST http://localhost:3000/v1/admin/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "blocklist-mules",
    "stage": "PRE",
    "priority": 10,
    "action": "DENY",
    "expression": { "in": [ { "var": "sender_id" }, ["mule_001", "mule_002"] ] }
  }'
```

Register a candidate model and activate it:

```bash
curl -X POST http://localhost:3000/v1/admin/models \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "version": "v1.1.0", "sourceUri": "s3://models/fraud/v1.1.0.onnx", "defaultThreshold": 0.6 }'

curl -X POST http://localhost:3000/v1/admin/models/v1.1.0/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{ "status": "ACTIVE" }'
```

Note: registering a model record updates the registry metadata only.
Hot-loading the ONNX bytes still happens via the existing
`MODEL_REGISTRY_URL` poller or the `cp models/*.onnx` swap.

### PAA Service (http://localhost:9090, dev / 9091 in docker-compose)

| Method | Endpoint    | Description                    |
|--------|-------------|--------------------------------|
| GET    | `/livez`    | Liveness                       |
| GET    | `/readyz`   | Readiness (Kafka + Postgres)   |
| GET    | `/metrics`  | Prometheus metrics             |
| GET    | `/stats`    | Internal counters              |

### FIA Service (http://localhost:9094)

| Method | Endpoint                                | Description                                                                 |
|--------|-----------------------------------------|-----------------------------------------------------------------------------|
| GET    | `/livez`                                | Liveness                                                                    |
| GET    | `/readyz`                               | Readiness (Kafka consumer up)                                               |
| GET    | `/stats`                                | processed / duplicates / failed / dropped_poison / in_flight_retries / llm_model |
| POST   | `/v1/reports`                           | On-demand report generation for any transaction (idempotent by `transaction_id`) |
| GET    | `/v1/reports`                           | List recent reports (`?status=GENERATED&limit=50&offset=0`)                 |
| GET    | `/v1/reports/{report_id}`               | Read a report + its full conversation history                               |
| POST   | `/v1/reports/{report_id}/messages`      | Ask a follow-up question; answer is grounded in the report                  |

Example — generate a report on demand, then ask a follow-up:

```bash
# Generate
curl -X POST http://localhost:9094/v1/reports \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user123",
    "amount": 1500,
    "transaction_type": "TRANSFER",
    "fraud_probability": 0.92
  }'
# → { id: "<report_id>", verdict: "FRAUD_CONFIRMED", narrative: "…", conversation: [] }

# Ask a follow-up
curl -X POST http://localhost:9094/v1/reports/<report_id>/messages \
  -H "Content-Type: application/json" \
  -d '{ "content": "Why is the recommended action BLOCK and not CONTACT_CUSTOMER?" }'
```

The conversational endpoint runs at LLM-inference latencies (seconds on
GPU/MPS, slower on CPU); on hosts where the LLM can't load, the
deterministic fallback keeps the UI functional with a templated answer.

## Synthetic Data & Replay

Two CLI helpers ship in `scripts/` for adoption demos and pre-prod regression:

```bash
# Generate 5,000 PaySim-style requests at concurrency 16
npm run seed:load -- --url http://localhost:3000 --count 5000 --concurrency 16 \
  --api-key fdk_... --tenant tenant-acme

# Replay yesterday's audit log against a candidate deployment, print a
# confusion-style summary comparing original vs candidate decisions
npm run replay -- --target http://localhost:3001 --since 2026-05-12 --limit 5000 \
  --api-key fdk_...
```

`replay.ts` reads directly from the `decisionAuditLog` table — the same
audit rows the platform writes for every prediction — so it's faithful to
real production traffic without retaining raw PII.

## Database Migrations

```bash
# Run all pending migrations
npm run db:migrate

# Rollback last migration
npm run db:migrate:rollback

# Create new migration
npm run db:migrate:make -- create_table_name
```

## Project Structure

```
multi-agent-fraud-detection/
├── src/                      # RDA — TypeScript / Fastify HTTP API (root package.json)
│   ├── config/
│   ├── database/migrations/  # Knex migrations (owned by RDA, shared by all services)
│   ├── shared/
│   │   ├── circuit-breaker/  # opossum breakers around Redis + ONNX
│   │   ├── kafka/            # KafkaProducer with LevelDB disk buffer
│   │   ├── metrics/
│   │   └── onnx/
│   └── v1/modules/rda/
│       ├── controller/
│       ├── routes/
│       ├── services/         # predict.service, feature.service
│       └── validations/
├── paa-service/              # PAA — TypeScript Kafka consumer worker
│   └── src/
│       ├── services/
│       │   ├── graph.service.ts        # graphology-based transaction graph
│       │   ├── velocity.service.ts     # 1h/24h/7d/30d windows
│       │   ├── redis-update.service.ts # batched feature flush
│       │   └── postgres.service.ts     # batched graph metadata flush
│       └── worker.ts                   # entry + inline /livez /readyz /metrics /stats server
├── mla-service/              # MLA — Python 3.11 (drift, retrain, ONNX export)
│   ├── src/
│   │   ├── monitoring/       # drift_detector.py (PSI + F1)
│   │   ├── training/         # trainer.py, validator.py (McNemar), preprocessor.py, dataset_loader.py
│   │   ├── deployment/       # onnx_converter.py, registry.py
│   │   └── main.py
│   ├── scripts/              # train_initial_model.py, train_with_datasets.py
│   └── models/               # versioned ONNX + scaler + metadata JSON artefacts
├── fia-service/              # FIA — Python 3.11 (Phi-3 LLM investigation reports)
│   └── src/
│       ├── consumer/         # kafka_consumer.py (per-partition commits)
│       ├── llm/              # phi3_generator.py, prompt.py, report_schema.py (Pydantic)
│       ├── persistence/      # report_writer.py (INSERT … ON CONFLICT DO NOTHING)
│       └── main.py           # entry + inline health server on :9094
├── frontend/                 # Sentinel dashboard — Vite + React 18 (port 5173)
│   └── src/
│       ├── app.jsx           # hash routing, shared state, tweaks panel host
│       ├── api/client.js     # /v1 + /fia calls wrapped in safe() with seed fallback
│       ├── components/       # shell.jsx (Sidebar, PageHead, Modal, helpers), tweaks-panel.jsx
│       ├── pages/            # 12 page screens — dashboard, review queue, rule editor, models, …
│       └── data/mock.js      # seed dataset used when the backend is unreachable
├── models/                   # Production ONNX model copied from mla-service/models/
├── docs/
│   ├── ARCHITECTURE.md       # System architecture and design notes
│   └── mermaid.md            # Mermaid source for the system diagrams
├── docker-compose.yml        # Production stack (3× RDA, 2× PAA, NGINX, Prometheus, Grafana)
├── docker-compose.dev.yml    # Hot-reload overrides for rda-dev / paa-dev
├── Dockerfile / Dockerfile.dev
└── CLAUDE.md                 # Working notes for Claude Code
```

## Reference Performance

Measured on a single developer workstation (Apple Silicon MacBook Pro, infra in Docker on
the same host). Treat these as orientation values, not SLA targets — re-measure on your
own hardware before relying on them.

| Path | Measurement |
|---|---|
| ONNX inference (batch=1) | p50 = 10 µs, p99 = 49 µs |
| RDA `POST /v1/predict` (single client) | p50 = 1.24 ms, p99 = 4.06 ms, ~711 req/s |
| RDA peak throughput | ~3,146 req/s @ 16 concurrent connections |
| MLA training (IEEE-CIS, 683k rows + 5-fold CV) | 27.67 s; held-out F1 = 0.554, AUC-ROC = 0.911 |
| FIA Phi-3-mini-4k-instruct (MPS, fp16) | 46 s LLM load; ~6–10 min one-time MPS warmup; ~40–90 s/report steady-state |

## Monitoring

### Prometheus (http://localhost:9090)

Collects metrics from RDA and PAA services.

### Grafana (http://localhost:3001)

- Default credentials: `admin` / `admin`
- Pre-configured Prometheus datasource

## Troubleshooting

### Port Already in Use

If port 5432 is in use (local PostgreSQL), the Docker PostgreSQL uses port 5433:

```bash
# Connect to Docker PostgreSQL
psql -h localhost -p 5433 -U postgres -d fraud_db
```

### Docker Daemon Not Running

```
Cannot connect to the Docker daemon. Is the docker daemon running?
```

Start Docker Desktop application.

### Container Won't Start

```bash
# Check logs for errors
docker compose logs fraud-rda-dev

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up
```

### Hot Reload Not Working

Ensure volumes are mounted correctly in `docker-compose.dev.yml`:

```yaml
volumes:
  - ./src:/app/src
```

## Tech Stack

- **Runtimes**: Node.js 18+ (RDA, PAA, frontend toolchain), Python 3.11 (MLA, FIA)
- **HTTP / framework**: Fastify 5.x with `tsyringe` DI and `module-alias` path resolution (RDA), KafkaJS standalone worker (PAA)
- **Frontend**: React 18 + Vite 5 (Sentinel operator dashboard, `frontend/`); Vitest + Testing Library for unit tests
- **Database**: PostgreSQL 14 (host port 5433), Redis 7 (host port 6380)
- **Message bus**: Apache Kafka (`transactions.completed` keyed by `sender_id`; `transactions.blocked` keyed by `transaction_id`)
- **Real-time inference**: ONNX Runtime (CPUExecutionProvider) on a 122 KB XGBoost model
- **Offline training**: XGBoost 2.x, scikit-learn, imbalanced-learn (SMOTE); ONNX export pinned to `onnx==1.13.0` / `onnxmltools==1.10.0`
- **Investigation LLM**: `microsoft/Phi-3-mini-4k-instruct` (3.8B params) via HuggingFace Transformers; CUDA → MPS → CPU device selection; deterministic rule-based fallback
- **Resilience**: `opossum` circuit breakers around Redis lookup and ONNX inference (RDA); fail-closed on inference failure; `INSERT … ON CONFLICT DO NOTHING` idempotency on FIA writes; per-partition Kafka offset commits
- **Metrics**: Prometheus + Grafana
- **Container**: Docker + Docker Compose
