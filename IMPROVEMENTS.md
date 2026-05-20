# Adoption Improvements

A roadmap of features that make the platform deployable by a real
fintech / payments / e-commerce company, organised by the buyer pain
point each one removes. Items marked **Implemented in this revision**
shipped in the same change as this document; the rest are scoped follow-ups.

## 1. Security and access control

| Item | Status |
|------|--------|
| API-key authentication on `/v1/predict`, scoped per tenant | Implemented |
| HMAC-signed key verification (server stores only the hash) | Implemented |
| Rate limit hook keyed off the API key (configurable per key) | Implemented |
| User auth (bcrypt + JWT) + RBAC (roles × permission catalogue) | Implemented |
| Operator UI for users + roles + password rotation | Implemented (`frontend/src/pages/{users,roles,change-password}.jsx`) |
| mTLS option for service-to-service callers | Follow-up |
| OAuth 2.0 client-credentials grant for human-driven admin APIs | Follow-up |

The auth layer lives in `src/shared/middlewares/api-key.middleware.ts`
and reads from `apiKeys` in Postgres. Bootstrap a key with
`POST /v1/admin/api-keys` (admin-key gated) — the **plaintext key is
returned exactly once**, only its `sha256` hash is persisted.

## 2. Audit trail and compliance

| Item | Status |
|------|--------|
| Immutable `decisionAuditLog` row for every prediction | Implemented |
| Reason codes (top-N feature contributions) on every decision | Implemented |
| Rule-override tracking (which rule fired, before/after decision) | Implemented |
| Human reviewer overrides with reason, persisted on the audit row | Implemented |
| `decision.overridden` webhook event | Implemented |
| Saved reports (operator-defined views over the audit log with filter + column projection + CSV/JSON export) | Implemented (`frontend/src/pages/reports.jsx`, plus `listSavedReports` / `runSavedReport` / `exportSavedReport` client helpers) |
| Optional PII tokenisation hook before any persistence | Follow-up |

Schema in `src/database/migrations/2026...create_decision_audit_log_table.ts`.
Every column needed for chargeback dispute, regulator request, or
post-hoc model evaluation is captured.

## 3. Decision explanations

| Item | Status |
|------|--------|
| Inline top-N reason codes on the `/v1/predict` response | Implemented |
| On-demand FIA investigation report for any transaction | Implemented |
| Conversational follow-up endpoint on FIA reports | Implemented |
| Reviewer UI on top of FIA (list, request, conversation thread) | Implemented (`frontend/src/pages/investigations.jsx` — uses `requestReport`, `postReportMessage`, `listReports`) |

Reason codes are computed from ONNX feature contributions using a
fast Gini-style score (`src/shared/onnx/reason-codes.ts`). The FIA
service exposes:

- `POST /v1/reports` — generate a report for any transaction (not
  just blocked ones).
- `POST /v1/reports/{report_id}/messages` — ask follow-up questions;
  turns are persisted in `investigationConversations`.
- `GET  /v1/reports/{report_id}` — read the canonical report + chat
  history.

## 4. Model lifecycle

| Item | Status |
|------|--------|
| `modelVersions` registry table (sha256, source URI, status, metrics) | Implemented |
| Activate / shadow / retire endpoints | Implemented |
| Filesystem-backed registry (`models/versions/<v>/`) — MinIO retired | Implemented |
| Per-segment thresholds (segment × model_version) | Implemented |
| Backtest endpoint (replay historical traffic) | Implemented (CLI) |
| Catalogue-driven feature contract (64 base + adopter overlay) | Implemented |
| Operator UI for the feature catalogue (read-only browser with category / source filters) | Implemented (`frontend/src/pages/features.jsx`) |
| Schema-version enforcement on model load | Implemented |
| Reviewer-override → `groundTruthFraud` propagation for retrain | Implemented |
| Champion / challenger automated promotion | Implemented (`mla-service/src/deployment/model_registry.py:_register_with_rda` — auto CANDIDATE → ACTIVE flip, gated by `validator.py:_make_decision` on McNemar significance + min-F1 improvement + no precision/recall regression) |
| Canary traffic split by API-key cohort | Follow-up |

Shadow mode means the candidate model is scored on every request and
written to the audit row alongside the champion score, but **only the
champion drives the decision**. Operators can compare distributions
in the audit table before flipping the switch.

## 5. Rules engine

| Item | Status |
|------|--------|
| `rules` table with priority, action (`ALLOW`, `DENY`, `REVIEW`, `NONE`), expression | Implemented |
| Pre-ML evaluation (skip ML if `ALLOW`/`DENY`) | Implemented |
| Post-ML evaluation (override ML decision) | Implemented |
| JSON-Logic-style expression evaluator with allow/deny semantics | Implemented |
| Hot-reload from Postgres every 30 s | Implemented |
| Operator UIs — rule editor (raw expression), rule builder (form-driven), rule templates library | Implemented (`frontend/src/pages/{rule-editor,rule-builder}.jsx` + `rule-templates.js`) |

Use cases: instant blocklist/allowlist, velocity caps, merchant-category
overrides, "auto-decline if amount > $X AND first-tx-from-sender".

## 6. Operations / integration

| Item | Status |
|------|--------|
| HMAC-signed webhooks for `decision.created` / `decision.overridden` / `model.activated` | Implemented |
| `Idempotency-Key` header on `/v1/predict` | Implemented |
| Synthetic-data load generator (`scripts/seed-load.ts`) | Implemented |
| Decision replay CLI (`scripts/replay.ts`) | Implemented |
| Service-health fan-out + operator dashboard page | Implemented (`src/v1/modules/health/` + `frontend/src/pages/service-health.jsx` probing RDA / PAA / MLA / FIA) |
| Helm chart / Terraform module | Follow-up |
| Pre-built connectors (Stripe / Adyen / Plaid) | Follow-up |
| TypeScript + Python client SDKs | Follow-up |

Webhook delivery is at-least-once with exponential backoff and a
`webhookDeliveries` ledger (status, last attempt, response code, body
snippet). Failed deliveries can be replayed via the admin API.

## 7. Adopter onboarding (time-to-value)

| Item | Status |
|------|--------|
| Synthetic data generator that produces realistic PaySim-style traffic | Implemented |
| Replay last N hours against a candidate model | Implemented |
| Curl examples in README cover auth, rules, webhooks, FIA chat | Implemented |
| FIA gated behind `--profile fia` so first-run is fast | Implemented |
| Demo dataset shipped in `data/demo/` | Follow-up |
| Hosted sandbox (`sandbox.<domain>`) | Follow-up (infra) |

## Roadmap snapshot (at launch — June 7, 2026)

```
Shipped ─────────────────────────────────────────────────────────────
  • API-key auth + rate limit hook
  • User auth + RBAC + operator UI for users/roles
  • Decision audit log + inline reason codes
  • Saved reports (operator-defined audit-log views, CSV/JSON export)
  • Rules engine (PRE + POST ML, hot-reload) + UI (editor / builder / templates)
  • Model registry (CANDIDATE → SHADOW → ACTIVE → RETIRED)
  • Per-segment thresholds
  • Catalogue-driven feature contract (64 base + adopter overlay)
  • Schema-version enforcement on model load
  • Reviewer-override → groundTruthFraud → MLA training (closed loop)
  • Champion / challenger automated promotion (McNemar-gated)
  • Reviewer UI on top of FIA (list + on-demand + conversation thread)
  • Webhooks (HMAC, delivery ledger, retry)
  • Idempotency keys
  • Synthetic data + replay CLIs
  • Service-health dashboard fanning out across all four agents

Next up ──────────────────────────────────────────────────────────────
  • Helm chart + Terraform module
  • Client SDKs (TypeScript, Python)
  • Pre-built connectors (Stripe / Adyen / Plaid)
  • Canary traffic split by API-key cohort
  • PII tokenisation hook + region-pinned storage
  • mTLS for service-to-service callers
  • OAuth 2.0 client-credentials grant for admin APIs
  • Demo dataset shipped under data/demo/
  • Hosted sandbox
```

See the relevant section of `README.md` for the full set of new
endpoints and environment variables.
