# Multi-Agent Fraud Detection

Open-source, self-hostable real-time fraud detection platform built as four
cooperating microservices around shared PostgreSQL / Redis / Kafka infrastructure.
Released under the MIT License — see [`LICENSE`](LICENSE).

The four services:

- **RDA (Real-Time Detection Agent)**: HTTP API using Fastify for fraud prediction with ONNX model inference, Redis feature retrieval, and Kafka event publishing
- **PAA (Pattern Analysis Agent)**: Standalone Kafka consumer worker for graph-based network analysis, velocity calculations, and feature engineering
- **MLA (Model Learning Agent)**: Python service for concept drift detection, automated model retraining, and A/B testing deployment
- **FIA (Fraud Investigation Agent)**: Python service that consumes blocked transactions and uses a fine-tuned Phi-3 LLM to generate analyst-readable investigation reports (async, never on the auth path)

## Architecture

```
                    ┌─────────────┐
                    │   NGINX     │
                    │   (LB)      │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐      ┌────▼────┐      ┌────▼────┐
    │  RDA-1  │      │  RDA-2  │      │  RDA-3  │
    └────┬────┘      └────┬────┘      └────┬────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
         │  Redis  │  │  Kafka  │  │ Postgres│
         └─────────┘  └────┬────┘  └─────────┘
                           │
              ┌────────────┼────────────┬──────────┐
              │            │            │          │
         ┌────▼────┐  ┌────▼────┐  ┌────▼────┐  ┌──▼──┐
         │  PAA-1  │  │  PAA-2  │  │   MLA   │  │ FIA │
         └─────────┘  └─────────┘  └─────────┘  └─────┘
```

PAA + MLA consume `transactions.completed` (keyed by `sender_id`).
FIA consumes a separate `transactions.blocked` topic (keyed by
`transaction_id`) — published by RDA only when the decision is `DECLINE`.
The dual-publish keeps FIA's seconds-per-LLM-call latency away from PAA's
millisecond pipeline.

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

| Method | Endpoint        | Description                   |
|--------|-----------------|-------------------------------|
| GET    | `/`             | Service info                  |
| GET    | `/livez`        | Liveness probe                |
| GET    | `/readyz`       | Readiness probe (Postgres + Redis) |
| POST   | `/v1/predict`   | Fraud prediction              |
| GET    | `/v1/metrics`   | Prometheus metrics            |

### Example Request

```bash
# Health check
curl http://localhost:3000/livez

# Service info
curl http://localhost:3000/

# Fraud prediction (transaction_type must be one of CASH_IN, CASH_OUT, PAYMENT, TRANSFER, DEBIT)
curl -X POST http://localhost:3000/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user123",
    "receiver_id": "user456",
    "amount": 1500.00,
    "transaction_type": "TRANSFER",
    "timestamp": 1713100800
  }'
```

The response is `{ fraud, fraud_probability, decision: "ACCEPT" | "DECLINE", latency_ms, timestamp }`. The decision is binary at threshold `FRAUD_THRESHOLD=0.65`; on `DECLINE`, RDA additionally publishes the event to `transactions.blocked` for the FIA.

### PAA Service (http://localhost:9090, dev / 9091 in docker-compose)

| Method | Endpoint    | Description                    |
|--------|-------------|--------------------------------|
| GET    | `/livez`    | Liveness                       |
| GET    | `/readyz`   | Readiness (Kafka + Postgres)   |
| GET    | `/metrics`  | Prometheus metrics             |
| GET    | `/stats`    | Internal counters              |

### FIA Service (http://localhost:9094)

| Method | Endpoint    | Description                    |
|--------|-------------|--------------------------------|
| GET    | `/livez`    | Liveness                       |
| GET    | `/readyz`   | Readiness (Kafka consumer up)  |
| GET    | `/stats`    | processed / duplicates / failed / dropped_poison / in_flight_retries / llm_model |

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

- **Runtimes**: Node.js 18+ (RDA, PAA), Python 3.11 (MLA, FIA)
- **HTTP / framework**: Fastify 5.x with `tsyringe` DI and `module-alias` path resolution (RDA), KafkaJS standalone worker (PAA)
- **Database**: PostgreSQL 14 (host port 5433), Redis 7 (host port 6380)
- **Message bus**: Apache Kafka (`transactions.completed` keyed by `sender_id`; `transactions.blocked` keyed by `transaction_id`)
- **Real-time inference**: ONNX Runtime (CPUExecutionProvider) on a 122 KB XGBoost model
- **Offline training**: XGBoost 2.x, scikit-learn, imbalanced-learn (SMOTE); ONNX export pinned to `onnx==1.13.0` / `onnxmltools==1.10.0`
- **Investigation LLM**: `microsoft/Phi-3-mini-4k-instruct` (3.8B params) via HuggingFace Transformers; CUDA → MPS → CPU device selection; deterministic rule-based fallback
- **Resilience**: `opossum` circuit breakers around Redis lookup and ONNX inference (RDA); fail-closed on inference failure; `INSERT … ON CONFLICT DO NOTHING` idempotency on FIA writes; per-partition Kafka offset commits
- **Metrics**: Prometheus + Grafana
- **Container**: Docker + Docker Compose
