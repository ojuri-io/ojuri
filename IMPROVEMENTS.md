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
| Reviewer UI on top of FIA | Follow-up (frontend) |

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
| Per-segment thresholds (segment × model_version) | Implemented |
| Backtest endpoint (replay historical traffic) | Implemented (CLI) |
| Canary traffic split by API-key cohort | Follow-up |
| Champion / challenger automated promotion | Follow-up (MLA-side hook) |

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

Use cases: instant blocklist/allowlist, velocity caps, merchant-category
overrides, "auto-decline if amount > $X AND first-tx-from-sender".

## 6. Operations / integration

| Item | Status |
|------|--------|
| HMAC-signed webhooks for `decision.created` / `decision.overridden` / `model.activated` | Implemented |
| `Idempotency-Key` header on `/v1/predict` | Implemented |
| Synthetic-data load generator (`scripts/seed-load.ts`) | Implemented |
| Decision replay CLI (`scripts/replay.ts`) | Implemented |
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
| Demo dataset shipped in `data/demo/` | Follow-up |
| Hosted sandbox (`sandbox.<domain>`) | Follow-up (infra) |

## Roadmap snapshot

```
Implemented in this revision ─────────────────────────────────────────
  • API-key auth + rate limit hook
  • Decision audit log + reason codes
  • Rules engine (pre + post ML)
  • Per-segment thresholds
  • Model registry (list / activate / shadow)
  • Webhooks (HMAC, delivery ledger)
  • Idempotency keys
  • FIA on-demand reports + conversational follow-ups
  • Synthetic data + replay CLI

Next up ──────────────────────────────────────────────────────────────
  • Reviewer UI on top of FIA
  • Helm chart + Terraform module
  • Client SDKs (TypeScript, Python)
  • Champion/challenger automated promotion
  • PII tokenisation + region-pinned storage
```

See the relevant section of `README.md` for the full set of new
endpoints and environment variables.
