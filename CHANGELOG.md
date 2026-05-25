# Changelog

All notable changes to Ojuri will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
