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
measures p99 ≈ 49 µs (batch=1); end-to-end `POST /v1/predict` measures
p99 ≈ 6 ms uncontended on a single developer workstation. Under
concurrent load the path is currently event-loop-bound; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#performance-characteristics)
for the loaded stress profile and benchmarking guidance (the shipped
NGINX rate limit and idempotency duplicate short-circuit both produce
misleading numbers in naïve tests — read the caveats before measuring).
Circuit breakers around Redis and ONNX keep the path degrading instead
of failing — predictions still succeed against default features when
Redis is down.

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
  skips both. Other 3.x versions are not supported — MLA pins ONNX toolchain
  versions that don't build cleanly elsewhere. Install via
  `brew install python@3.11` (macOS), `apt install python3.11` (Debian/Ubuntu),
  or `pyenv install 3.11`. The exact binary name (`python3.11` vs `python3` vs
  pyenv-shimmed `python`) depends on how you installed it — use whichever
  resolves to `Python 3.11.x` for `--version`.
- **Docker 20.10+** with Compose v2.
- **Host ports** kept free: `80 3000 3001 5173 5433 6380 9090 9091 9093 9094 29092`.
  Postgres in Docker listens on `5433` (not `5432`) to avoid host conflicts.
- **Disk and RAM if running FIA**: ~10 GB free disk for the Phi-3 weights and
  ≥16 GB free RAM for the loaded model. On Apple Silicon, the first
  investigation triggers a one-time 6–10 minute MPS kernel compilation — this
  is normal, not a hang.

## Quick start

> **On Windows?** Follow [`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md)
> instead — it covers the Windows installer flow, `py -3.11` invocation,
> the MSVC redistributable XGBoost needs, and the cmd/PowerShell
> activation syntax. The commands below assume a POSIX shell.

Clone, start the stack, send a prediction. Two install options — pick one:

**Run published images** (adopters):

````bash
git clone --depth 1 --branch v1.4.0 https://github.com/ojuri-io/ojuri.git
cd ojuri
cp .env.example .env                        # provides AUTH_JWT_SECRET, DB creds, CORS
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
docker compose logs db-migrate              # one-time admin password printed here
````

**Build from source** (contributors):

````bash
git clone https://github.com/ojuri-io/ojuri.git
cd ojuri
cp .env.example .env                        # provides AUTH_JWT_SECRET, DB creds, CORS
docker compose up -d --build                # builds RDA + PAA on first run (a few minutes)
docker compose logs db-migrate              # one-time admin password printed here
````

Either way brings up Postgres, Redis, Kafka, the RDA replicas behind
NGINX (`RDA_REPLICAS` in `.env`, default 3), the PAA singleton worker, a
one-shot `db-migrate` container, and
Prometheus/Grafana. MLA and FIA are opt-in — see
[Install options](#install-options) and
[Training a model](#training-a-model-mla). The `.env` copy is required:
RDA refuses login without `AUTH_JWT_SECRET`.

### Send a test prediction

The example uses the six required fields plus a few common context fields;
the API accepts ~40 optional context fields (device, geography, identity,
agent, recipient, …) that improve prediction quality when supplied — see
[`docs/PREDICT-API.md`](docs/PREDICT-API.md) for the full field reference.

> `transaction_id` is the single identifier Ojuri tracks. It's
> caller-controlled — any 10–255 char string is accepted, so plug in
> whatever your upstream system already issues (UUID, ULID, PSP txn
> ref, order id, your own format). The same string is what the audit
> row carries, what `transactions.completed` /
> `transactions.blocked` are partitioned by (for blocked events), and
> what Sentinel searches against. Make it unique per transaction
> within your tenant (the `transactions` table enforces uniqueness),
> and pass it as `Idempotency-Key` if you want replay-safe POSTs.

````bash
curl -X POST http://localhost/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user_a",
    "receiver_id": "user_b",
    "amount": 300.00,
    "transaction_type": "TRANSFER",
    "timestamp": 1717718400000,
    "is_authenticated": true,
    "device_is_trusted": true,
    "account_age_days": 900
  }'
````

The response shape (from `PredictResponseDto`) — values are illustrative,
reason codes vary with the live feature snapshot:

````json
{
  "transaction_id": "550e8400-…",
  "fraud": false,
  "fraud_probability": 0.0773,
  "decision": "ACCEPT",
  "decision_source": "ML",
  "reason_codes": [
    { "code": "VELOCITY_1H",     "description": "Transactions in the last hour above baseline", "contribution":  0.28, "value": 9 },
    { "code": "PAGERANK",        "description": "Network-centrality score from the transaction graph", "contribution": -0.20, "value": 0.35 },
    { "code": "CLUSTERING_COEF", "description": "How tightly the sender clusters with known peers", "contribution": 0.11, "value": 0 }
  ],
  "model_version": "default",
  "threshold": 0.65,
  "audit_id": "38fb28d2-…",
  "latency_ms": 9,
  "timestamp": 1717718400123
}
````

> **What you'll see on a fresh install.** Two things surprise first-time
> users, both expected:
> - `"model_version": "default"` — the demo ONNX model scores every
>   prediction, but no version is registered in the model registry yet,
>   so the label falls back to `default`. It becomes `v1.x` once you
>   register a trained model (see [Training a model](#training-a-model-mla)).
> - The **demo rules** seed *inactive* by default — their amount
>   thresholds (`DENY` ≥ ₦100k, `REVIEW` on ₦500–10k `PAYMENT`s) are
>   demo-dataset props that would otherwise flag large slices of real
>   traffic and shadow the FATF pack. Set `SEED_DEMO_RULES_ACTIVE=true`
>   before first boot (or toggle them in Sentinel → Rules) when walking
>   through the demo dataset. A flagged response with
>   `"decision_source": "PRE_RULE"` is a rule firing, not the model.

That's clone to a scored transaction. Next: bring up the
[dashboard](#running-the-dashboard), [seed demo data](#demo--test-data),
or [train your own model](#training-a-model-mla).

---

## Install options

The two paths run the same stack and the same `docker-compose.yml`; they
differ only in whether the RDA/PAA/Sentinel images are pulled from GHCR or
built locally.

**Published images.** The shallow clone fetches only the `v1.4.0` tag
(~5 MB) for the compose files, `.env.example`, and config. The `pull` step
downloads the five signed images from
`ghcr.io/ojuri-io/{rda,paa,mla,fia,sentinel}` — public, no login needed. A
one-shot `db-migrate` container applies migrations and seeds before RDA
accepts traffic, and re-runs as a no-op on subsequent `up`.

`OJURI_VERSION` defaults to `v1` (floating major — receives patches and
minors automatically per [`VERSIONING.md`](VERSIONING.md)). Pin strictly
for regulated deployments:

````bash
export OJURI_VERSION=v1.4.0   # before any docker compose command
````

> **Docker Compose 2.24+** is required for the GHCR overlay (uses the
> `!reset` directive). Check with `docker compose version`. Older Compose
> versions need the build-from-source path.

**Build from source.** `docker compose up -d --build` builds RDA + PAA on
first run (a few minutes), then starts the same services.

**What comes up, either way:** Postgres, Redis, Kafka, the RDA replicas
(`RDA_REPLICAS` in `.env`, default 3) behind NGINX, the PAA singleton worker (`paa_group_members` must stay at 1
— see [`paa-service/README.md`](paa-service/README.md) for the rationale),
the `db-migrate` one-shot (Knex migrations + seeds, exits cleanly), and the
Prometheus/Grafana stack. FIA is behind a profile because it carries
~7.6 GB of Phi-3 weights — opt in with `docker compose --profile fia up -d`
when you have the disk and RAM.

> Copying `.env.example` to `.env` is required before `docker compose up` —
> RDA refuses `/v1/auth/login` without `AUTH_JWT_SECRET`, and the
> Knex-backed admin endpoints need the `DB_*` block. Rotate
> `AUTH_JWT_SECRET` before any non-dev deploy.

> Make sure the Docker daemon is running first — start Docker Desktop
> (macOS/Windows) or `sudo systemctl start docker` (Linux) and confirm with
> `docker info`. Compose fails with `Cannot connect to the Docker daemon`
> if it isn't up.

---

## Running the dashboard

Sentinel (the operator dashboard) runs separately from the backend. If you
brought the backend up with `docker compose up -d`, point Vite at NGINX
before starting it — otherwise the dev server targets a host-side RDA on
`:3000` and login returns a 502 from the proxy:

````bash
cd frontend
npm install
cp .env.example .env       # then edit: uncomment the "Docker stack" block
npm run dev                # http://localhost:5173
````

For host-side dev (`npm run start:dev` from the repo root for RDA), the
default targets in `.env.example` already point at `127.0.0.1:3000`, so
`cp .env.example .env` is optional.

Log in with the **seeded admin password from `docker compose logs
db-migrate`** (build-from-source on the host: `npm run db:migrate`). The
seeded user has `mustChangePassword=true`; the first login forces a
rotation. To require `X-Api-Key` on `/v1/predict`, set
`RDA_REQUIRE_API_KEY=true` and issue a key from `POST /v1/admin/api-keys`.

Lost the seeded password? It's only printed once. `npm run reset:admin`
mints a fresh random one (or pass `-- --password 'my-chosen-secret'` to set
your own); the new password again has `mustChangePassword=true`.

---

## Demo & test data

A fresh stack has an empty dashboard until predictions flow. The demo
seeder posts ~500 realistic transactions — 50 recurring senders plus
embedded fraud patterns (a money ring, a mule fan-out, VPN sessions,
structuring) — so every Sentinel page has data to show:

````bash
docker compose --profile demo run --rm demo-seed   # against the running stack
node scripts/demo-traffic.mjs                      # or from the host (RDA_URL=… to override)
````

The demo dataset is paired with the demo rule pack, which seeds
*inactive* by default. For the intended ACCEPT/REVIEW/DECLINE mix,
activate it first: `SEED_DEMO_RULES_ACTIVE=true` in `.env` before the
first `docker compose up`, or flip the four `demo:` rules on in
Sentinel → Rules.

To measure detection quality — not just populate the UI — run the
persona-driven benchmark in
[`docs/FRAUD_SIMULATION.md`](docs/FRAUD_SIMULATION.md): ~128k transactions
with six fraud typologies, scored per typology before and after a
label-driven retrain. It's how the numbers in [Status](#status) were
produced, and it runs against your own deployment. Match its reference
configuration before comparing numbers: demo rule pack disabled and
`review_margin=0.08` (`PUT /v1/admin/settings/runtime/review_margin`, or
Sentinel → Settings) — the review band is what turns model uncertainty
into analyst labels, and it ships at 0.

---

## Training a model (MLA)

A 120 KB demo ONNX model (`models/fraud_model.onnx`, a PaySim-trained
XGBoost) ships in the repo so `/v1/predict` returns real ML decisions out
of the box; the performance numbers here were measured against it. Replace
it once MLA has trained on your data.

MLA runs either inside Compose under the `mla` profile or on a host venv.
The host-venv path is the historical default and is recommended when you
want GPU access for training. To run MLA in Compose, add `--profile mla` to
any `up` command and set `MLA_HEALTH_URL=http://mla:9095` in `.env` so the
RDA replicas probe the in-Compose service instead of `host.docker.internal`.

Host-venv first-time setup:

````bash
cd mla-service
python --version                # must report Python 3.11.x — see Prerequisites
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m src.main
````

If `python` on your PATH isn't 3.11, substitute the binary your installer
provides (`python3.11` / `python3` on Debian/Ubuntu, or the pyenv shim once
`pyenv local 3.11` is set here). Windows: see
[`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md). On subsequent runs, just
`source venv/bin/activate && python -m src.main`. Sentinel's "System health"
page shows MLA offline until you start it — expected unless you wire MLA
into your deployment.

On a fresh checkout MLA logs a one-time `⚠️  No production model found in
registry` and idles waiting for drift signals. This is **not** a conflict
with the shipped demo model — `models/fraud_model.onnx` is what RDA loads
so predictions work, whereas MLA's registry scans `models/versions/<v>/`
for lineage-tracked versions, and that directory ships empty. To seed
`models/versions/v1.0/` immediately (so MLA has a baseline for its first
A/B comparison):

````bash
python scripts/train_initial_model.py     # writes models/versions/v1.0/{model.onnx,model.json,scaler.npz,meta.json}
````

Without real `fraudLabel` data in Postgres, the script falls back to
synthetic data and logs a warning — fine for a dev walkthrough, not for
production results. Then activate via the admin UI or copy the `.onnx` to
`models/fraud_model.onnx` for RDA to pick up (replacements are gitignored).
See [`docs/TRAINING.md`](docs/TRAINING.md) for training on your own data.

Every model load (boot or hot-reload) runs a two-check calibration probe: a
deterministic re-run and a clearly-legit vs clearly-fraud discrimination
test. If either fails — file missing, constant output, wrong feature
dimension — `/readyz` reports `{"name":"onnx-model","status":"DOWN"}` and
the circuit breaker fail-closes every predict to `1.0` (DECLINE) until a
working model loads. There is no degraded-mode heuristic that would
silently serve random predictions.

---

## Troubleshooting

- **`Cannot connect to the Docker daemon`** — start Docker Desktop or
  `sudo systemctl start docker`; confirm with `docker info`.
- **Login returns 502 (dashboard)** — the frontend `.env` isn't pointing at
  NGINX. Uncomment the "Docker stack" block in `frontend/.env`; see
  [Running the dashboard](#running-the-dashboard).
- **`crypto.getRandomValues is not a function` on `npm run dev`** — Node is
  older than 18. The repo pins 20 in `.nvmrc`; run `nvm use` in the repo
  root.
- **Dashboard opens on a different port** — another Vite project holds 5173,
  so Vite serves on the next free port. Use the URL it prints, not a
  bookmark.
- **First prediction returns `DECLINE` for a bare request** — with no
  context fields and a cold feature cache, the demo model scores the default
  vector as risky. Add context fields (as in the Quick start example) or
  send more traffic so PAA warms the cache.
- **`PRE_RULE` on a request you expected the model to score** — a seeded
  rule fired first: one of the FATF pack, or a demo rule if you enabled
  them (`SEED_DEMO_RULES_ACTIVE=true`); see the fresh-install note in
  Quick start.
- **Lost the admin password** — `npm run reset:admin`.

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
- [Fraud simulation benchmark](docs/FRAUD_SIMULATION.md) — persona-driven detection benchmark; reference before/after-retrain scorecard
- [Audit log](docs/AUDIT.md) and [Reason codes](docs/REASON-CODES.md)
- [Webhooks](docs/WEBHOOKS.md) — HMAC signing, retry, delivery ledger
- [Idempotency](docs/IDEMPOTENCY.md) — `Idempotency-Key` semantics on `/v1/predict`
- [FIA HTTP API](docs/FIA-API.md) — on-demand reports and follow-up messages
- [Sentinel frontend](docs/FRONTEND.md) — layout, auth, offline demo mode
- [Roadmap](ROADMAP.md) — what's planned next, what's out of scope
- [Changelog](CHANGELOG.md) — per-release history
- [Versioning policy](VERSIONING.md) — SemVer, lockstep across all five services, pinning recommendation
- [Upgrading](UPGRADING.md) — major-version upgrade paths (none yet — v1 is the initial release)
- [Security policy](SECURITY.md) — supported versions, disclosure channel
- Service-level READMEs: [`paa-service/`](paa-service/), [`mla-service/`](mla-service/README.md), [`fia-service/`](fia-service/README.md), [`frontend/`](frontend/README.md)

---

## Releases

Ojuri ships as a single tagged release that applies to all five
services — RDA, PAA, MLA, FIA, and Sentinel — in lockstep. Each
release publishes Docker images to GHCR under
`ghcr.io/ojuri-io/<service>` with both an exact-version tag
(`:v1.4.2`) and a floating major tag (`:v1`). See
[`VERSIONING.md`](VERSIONING.md) for the full policy.

### Pin to `:v1` in production

Adopters running from the published images should pin to the
floating major tag in their compose file or Helm values:

````yaml
# Pin to :v1 to receive bug-fix and feature releases automatically.
# Breaking changes ship as :v2 and never land here without you
# explicitly bumping. See VERSIONING.md.
services:
  rda:
    image: ghcr.io/ojuri-io/rda:v1
  paa:
    image: ghcr.io/ojuri-io/paa:v1
  mla:
    image: ghcr.io/ojuri-io/mla:v1
  fia:
    image: ghcr.io/ojuri-io/fia:v1
  sentinel:
    image: ghcr.io/ojuri-io/sentinel:v1
````

If you need stricter pinning (regulated environments, certified
builds), use the exact version (`:v1.4.2`) or the image digest.
You then take on the responsibility of upgrading manually for
each release.

### Upgrading

**Docker adopters** (using the published images via the GHCR overlay):

````bash
git pull --tags                                     # refresh tags + compose files
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
````

**Source adopters** (building from a `git clone`):

````bash
git pull
docker compose up -d --build
````

Read the [`CHANGELOG.md`](CHANGELOG.md) entry for any minor or
major bump before deploying — even though minor releases are
designed to be safe, the changelog often calls out new env
variables you may want to set explicitly. Major bumps require
reading [`UPGRADING.md`](UPGRADING.md).

### Get notified of releases

Click **Watch → Custom → Releases** on the
[GitHub repository](https://github.com/ojuri-io/ojuri) to receive
an email whenever a new tag is published. Security advisories use
the same notification channel.

---

## Status

Stable as of v1.4.0: API-key auth, JWT user auth and RBAC, hot-reloaded rules
engine, model registry with per-segment thresholds, decision audit log with
inline reason codes, HMAC-signed webhooks, idempotency keys, FIA on-demand
reports and conversational follow-ups, the Sentinel dashboard — and the label
feedback loop: chargebacks/disputes in via `POST /v1/admin/labels`,
label-volume retrains with temporal splits and a binding deployment gate,
live shadow scoring with champion-vs-shadow ground-truth metrics, and a
REVIEW band that turns model uncertainty into analyst labels.

Detection is validated end-to-end by a reproducible 128k-transaction persona
simulation — 34% of fraud caught cold, 98.8% after one label-driven retrain
at 1.1% FPR. Those numbers were measured with the demo rule pack disabled
and `review_margin=0.08` (a default fresh install seeds the review margin
at 0, so the ML never returns REVIEW until you set one). See
[`docs/FRAUD_SIMULATION.md`](docs/FRAUD_SIMULATION.md) for the full run
configuration and to run it against your own deployment.

Scoped follow-ups (see [`ROADMAP.md`](ROADMAP.md)): Helm chart and Terraform
module, TypeScript and Python client SDKs, canary traffic split by API-key
cohort, PII tokenisation hooks, mTLS for service-to-service callers,
OAuth 2.0 client-credentials grant, pre-built connectors (Stripe / Adyen /
Plaid), hosted sandbox.

Performance numbers in this README are orientation values measured on a single
Apple Silicon developer workstation, not SLA targets — re-measure on your own
hardware before relying on them.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

*Ojuri (Yoruba: ojúrí) — "the seeing eye." A witness to every transaction.*
