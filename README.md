# Ojuri

[![CI](https://github.com/ojuri-io/ojuri/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ojuri-io/ojuri/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Open source fraud detection that bears witness to every transaction.

Ojuri is a multi-agent fraud detection platform for fintech, payments, and
e-commerce. It scores transactions in real time, learns from emerging patterns,
explains every decision in plain language, and stays under your roof — no SaaS,
no data egress, no per-call fees. MIT licensed; self-hostable from a single
`docker compose up`.

The name is Yoruba (*ojúrí*) for *the seeing eye* — what a witness brings to a
transaction. That's also the system's job: observe what happens, attest to what's
true, and give analysts the evidence they need to decide.

---

## Why Ojuri

**Self-hosted, single binary blast radius.** Every service ships as a container.
Transactions never leave your infrastructure, which keeps strict data-residency
regimes (GDPR, NDPR, CBN) tractable without a separate compliance project.

**Four cooperating agents, decoupled by Kafka.** RDA decides in milliseconds.
PAA does graph and velocity analysis off the hot path. MLA monitors drift and
retrains. FIA generates LLM-written investigation reports for blocked
transactions. Failure of any agent except RDA never affects authorization.

**LLM investigations on a separate path.** Every `DECLINE` is republished to a
second Kafka topic that only FIA consumes. A self-hosted Phi-3-mini produces a
structured report — verdict, recommended action, key indicators, narrative —
written to Postgres and surfaced in the Sentinel dashboard. The investigation
runs at LLM latency (seconds), never on the authorization path.

**Inline reason codes on every prediction.** The `/v1/predict` response carries
the top contributing features (`AMOUNT_HIGH`, `VELOCITY_24H`, `PAGERANK`, …) so
clients can act on the decision without a follow-up call. The FIA report is for
analyst-grade depth, not basic explainability.

**MLOps surface, not shell scripts.** Model registry with CANDIDATE → SHADOW →
ACTIVE lifecycle, per-segment thresholds, drift detection (F1 + PSI), automated
SMOTE-balanced XGBoost retraining, McNemar significance check before promotion,
and a replay CLI that runs candidates against the live audit log.

**Real-time latency budget.** ONNX inference on the deployed XGBoost model
measures p99 ≈ 49 µs (batch=1); end-to-end `POST /v1/predict` measures p99 ≈
4 ms on a single developer workstation. Circuit breakers around Redis and ONNX
keep the path degrading instead of failing — predictions still succeed against
default features when Redis is down.

**Operator dashboard included.** Sentinel (Vite + React) ships under
`frontend/`: live decisions, review queue with overrides, rule editor, model
registry, audit log, FIA investigations, user/role admin. Reviewer overrides
write back to `groundTruthFraud` so the model doesn't learn from its own past
decisions.

---

## Prerequisites

- **Node 20+** (see `.nvmrc`) and **npm 10+** for RDA, PAA, and the frontend.
- **Python 3.11** only if you intend to run MLA (training) or FIA (LLM
  investigation reports) directly on the host. The default `docker compose up`
  skips both.
- **Docker 20.10+** with Compose v2.
- **Host ports** kept free: `80 3000 3001 5173 5433 6380 9090 9091 9093 9094 29092`.
  Postgres in Docker listens on `5433` (not `5432`) to avoid host conflicts.
- **Disk and RAM if running FIA**: ~10 GB free disk for the Phi-3 weights and
  ≥16 GB free RAM for the loaded model. On Apple Silicon, the first
  investigation triggers a one-time 6–10 minute MPS kernel compilation — this
  is normal, not a hang.

## Quick start

````bash
git clone https://github.com/ojuri-io/ojuri.git
cd ojuri
cp .env.example .env                        # provides AUTH_JWT_SECRET, DB creds, CORS
docker compose up -d                        # builds RDA on first run (a few minutes)
npm install && npm run db:migrate           # migration prints a one-time admin password
````

That brings up Postgres, Redis, Kafka, three RDA replicas behind NGINX, two
PAA workers, and the Prometheus/Grafana stack. FIA is gated behind a profile
because it carries ~7.6 GB of Phi-3 weights — opt in with
`docker compose --profile fia up -d fia` when you have the disk and RAM.

> MLA (the model trainer) is intentionally **not** in Compose — it runs on
> the host venv (`cd mla-service && python -m src.main`). The "System health"
> page in Sentinel will show MLA as offline until you start it locally; that
> is expected unless you wire MLA into your own deployment.

> Copying `.env.example` to `.env` is required before `docker compose up` —
> RDA refuses `/v1/auth/login` without `AUTH_JWT_SECRET`, and the Knex-backed
> admin endpoints need the `DB_*` block. Rotate `AUTH_JWT_SECRET` before any
> non-dev deploy.

> A 120 KB demo ONNX model (`models/fraud_model.onnx`, derived from a
> PaySim-trained XGBoost) ships in the repo so `/v1/predict` returns
> real ML decisions out of the box — `decision_source` will read `"ML"`,
> not `"MOCK"`. The performance numbers in this README were measured
> against this same model. Replace it with your own once MLA has trained
> on your data: `cd mla-service && python scripts/train_initial_model.py`
> writes `models/versions/<v>/model.onnx`; activate it via the admin UI
> or copy it to `models/fraud_model.onnx` for RDA to pick up. Replacements
> are gitignored so retrained models don't accidentally land in commits.
>
> If you delete the demo model and don't replace it, RDA falls back to a
> placeholder inference that returns pseudo-random scores —
> `/readyz` reports `DOWN` and a loud startup warning fires so the
> degraded mode is unmissable.

The dashboard runs separately. If you brought the backend up with
`docker compose up -d` (the quickstart above), tell vite to proxy
through NGINX before starting it — otherwise the dev server defaults
to `http://localhost:3000` (a host-side RDA) and login returns a 502
from the proxy:

````bash
cd frontend
npm install
cp .env.example .env       # then edit: uncomment the "Docker stack" block
npm run dev                # http://localhost:5173
````

For host-side dev (`npm run start:dev` from the repo root for RDA), the
default targets in `.env.example` already point at `127.0.0.1:3000` —
`cp .env.example .env` is optional.

Send a test prediction. The example below uses only the six
required fields; the API also accepts ~40 optional context fields
(device, geography, identity, agent, recipient, …) that improve
prediction quality when supplied — see
[`docs/PREDICT-API.md`](docs/PREDICT-API.md) for the full field
reference.

````bash
curl -X POST http://localhost:3000/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user_a",
    "receiver_id": "user_b",
    "amount": 1500.00,
    "transaction_type": "TRANSFER",
    "timestamp": 1717718400000,
    "segment": "high_value"
  }'
````

The response shape (from `PredictResponseDto`):

````json
{
  "transaction_id": "550e8400-…",
  "fraud": false,
  "fraud_probability": 0.1842,
  "decision": "ACCEPT",
  "decision_source": "ML",
  "reason_codes": [
    { "code": "AMOUNT_HIGH",  "description": "Transaction amount relative to typical range", "contribution":  0.27, "value": 1500.0 },
    { "code": "VELOCITY_24H", "description": "Transactions in the last 24 hours above baseline", "contribution": -0.05, "value": 4.0 }
  ],
  "model_version": "default",
  "threshold": 0.65,
  "audit_id": "f3d7c0bc-…",
  "latency_ms": 3,
  "timestamp": 1717718400123
}
````

Log in to the dashboard with the **seeded admin password printed by
`npm run db:migrate`** — copy it from the migration output. The seeded user
has `mustChangePassword=true`; the first login forces a rotation. To require
`X-Api-Key` on `/v1/predict`, set `RDA_REQUIRE_API_KEY=true` and issue a key
from `POST /v1/admin/api-keys`.

---

## Architecture

RDA is the only producer. Clients hit `POST /v1/predict` through NGINX; RDA
runs hot-reloaded rules (PRE), reads features from Redis (PAA-maintained), runs
ONNX inference with per-segment thresholds, applies POST rules, writes an
audit row, and publishes the event to Kafka. PAA consumes
`transactions.completed` (keyed by `sender_id`) and updates the graph and
velocity windows that feed RDA's next prediction. MLA consumes the same topic
for drift monitoring. On `DECLINE`, RDA additionally publishes to
`transactions.blocked` (keyed by `transaction_id`) for FIA to investigate at
LLM latency without affecting PAA's hot path.

````mermaid
flowchart TB
    Client[Client / PSP]
    UI[Sentinel Dashboard<br/>React + Vite]
    NGINX[NGINX]
    RDA[RDA · Fastify<br/>rules · ONNX · audit · webhooks]
    PAA[PAA · KafkaJS worker<br/>graph + velocity]
    MLA[MLA · Python<br/>drift + retrain]
    FIA[FIA · Python<br/>Phi-3 LLM]
    Kafka[(Kafka)]
    PG[(Postgres · fraud_db)]
    Redis[(Redis · features)]
    Models[(models/versions/ FS)]

    Client -->|POST /v1/predict| NGINX --> RDA
    UI -->|/v1/admin/*| RDA
    UI -->|/v1/reports*| FIA
    RDA -->|transactions.completed<br/>key = sender_id| Kafka
    RDA -->|transactions.blocked · DECLINE only<br/>key = transaction_id| Kafka
    RDA <--> Redis
    RDA --> PG
    Kafka --> PAA --> Redis
    PAA --> PG
    Kafka --> MLA
    MLA --> PG
    MLA -->|writes new version| Models
    Models -->|hot-swap on ACTIVE| RDA
    Kafka --> FIA --> PG
    RDA -.HMAC webhooks.-> Subscribers[(subscriber endpoints)]
````

Full system notes, per-service responsibilities, and data-flow diagrams live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — services, data flow, deployment topology
- [Documentation index](docs/README.md) — full per-feature reference
- [Authentication (API keys)](docs/AUTH.md) and [Authorization (users/roles/JWT)](docs/AUTHZ.md)
- [Rules engine](docs/RULES.md) — JSON-Logic DSL, PRE/POST stages, hot reload
- [Model registry](docs/MODEL-REGISTRY.md) — lifecycle, segment thresholds
- [Feature catalogue](docs/FEATURES.md) — base + adopter overlay, schema versioning
- [Training](docs/TRAINING.md) — load data, train, register, activate
- [Audit log](docs/AUDIT.md) and [Reason codes](docs/REASON-CODES.md)
- [Webhooks](docs/WEBHOOKS.md) — HMAC signing, retry, delivery ledger
- [Idempotency](docs/IDEMPOTENCY.md) — `Idempotency-Key` semantics on `/v1/predict`
- [FIA HTTP API](docs/FIA-API.md) — on-demand reports and follow-up messages
- [Sentinel frontend](docs/FRONTEND.md) — layout, auth, offline demo mode
- [Roadmap](ROADMAP.md) — what's planned next, what's out of scope
- [Changelog](CHANGELOG.md) — per-release history
- Service-level READMEs: [`paa-service/`](paa-service/), [`mla-service/`](mla-service/README.md), [`fia-service/`](fia-service/README.md), [`frontend/`](frontend/README.md)

---

## Status

The platform is approaching 1.0. Released in this revision and stable: API-key
auth, JWT user auth and RBAC, hot-reloaded rules engine, model registry with
per-segment thresholds, decision audit log with inline reason codes, HMAC-signed
webhooks, idempotency keys, FIA on-demand reports and conversational follow-ups,
synthetic-data and replay CLIs, the Sentinel dashboard.

Scoped follow-ups (see [`ROADMAP.md`](ROADMAP.md)): Helm chart and Terraform
module, TypeScript and Python client SDKs, canary traffic split by API-key
cohort, PII tokenisation hooks, mTLS for service-to-service callers,
OAuth 2.0 client-credentials grant, pre-built connectors (Stripe / Adyen /
Plaid), demo dataset, hosted sandbox.

Performance numbers in this README are orientation values measured on a single
Apple Silicon developer workstation, not SLA targets — re-measure on your own
hardware before relying on them.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

*Ojuri (Yoruba: ojúrí) — "the seeing eye." A witness to every transaction.*
