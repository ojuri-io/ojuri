# Fitting Ojuri into an existing system

For adopters who already run a transaction platform — and possibly an
existing fraud/rules stack — and need to know where Ojuri sits, how much
of it they have to adopt on day one, and what stays theirs. This is a
fit-and-rollout guide, not a field reference; see the doc map at the
bottom for the detailed specs.

## What Ojuri is

One synchronous call — `POST /v1/predict` — that takes a transaction and
returns a decision (`ACCEPT` / `REVIEW` / `DECLINE`), a score, and reason
codes. Everything else in the platform (Sentinel dashboard, investigation
reports, retraining, webhooks) hangs off that one call and the audit
trail it writes. Ojuri does not touch settlement, ledgering, KYC, or
chargeback recovery — you keep those.

## Where it plugs in

Call `POST /v1/predict` from the point in your pipeline where you
currently make (or would make) a fraud/risk decision — typically right
before you commit a transaction. Minimal request:

```json
POST /v1/predict
Content-Type: application/json
X-Api-Key: fdk_<prefix>_<secret>

{
  "transaction_id": "your-own-id-min-10-chars",
  "sender_id": "acct-123",
  "receiver_id": "acct-456",
  "amount": 50000,
  "transaction_type": "TRANSFER",
  "timestamp": 1735689600000
}
```

If you are calling from Node, `@ojuri/sdk` wraps this call with typed
requests and responses, retry and idempotency handling, and a verifier for the
webhooks below:

```bash
npm install @ojuri/sdk
```

It covers the predict path and webhook verification only — the audit reads and
the FIA report API are Sentinel's surface. See
[`packages/sdk/README.md`](../packages/sdk/README.md).

The six fields above are all that's required. Every other field in
[`PREDICT-API.md`](PREDICT-API.md) (identity, device, geography, channel,
display names) is optional and only sharpens the score — the catalogue
substitutes defaults for anything you don't send. You don't need to
restructure your transaction model to try Ojuri; you need one HTTP call
with data you almost certainly already have on hand at decision time.

## How much authority to hand over — pick one to start

You don't have to let Ojuri block transactions on day one. Three
integration depths, roughly in rollout order:

### 1. Observe-only (shadow)

Call `/v1/predict`, log the response (decision, score, reason codes),
but keep your existing system as the sole source of truth for
approve/decline. This is the lowest-risk way to see how Ojuri would have
scored your real traffic before it can affect a single customer. Every
call still writes a full row to `decisionAuditLog` (see
[`AUDIT.md`](AUDIT.md)), so you get a queryable comparison against your
existing system's calls for the same window.

### 2. Advisory

Route `REVIEW` and `DECLINE` responses into your existing manual-review
queue instead of auto-blocking. `ACCEPT` passes straight through. This
is a good middle step if you already have a fraud-ops team and a review
tool — Ojuri becomes a second signal into a process you keep.

### 3. Authoritative

Ojuri's decision is final: `DECLINE` blocks the transaction inline,
`REVIEW` routes to Sentinel's review queue, `ACCEPT` proceeds. This is
where the full loop closes — reviewer overrides in Sentinel feed back as
ground truth (`docs/AUDIT.md` → override endpoint) and retrain
automatically on enough of them.

Nothing in the API changes between these three modes — the difference is
entirely in what your calling code does with the response. Moving from
1 → 3 is a code change on your side, not a config flag on Ojuri's.

## Bringing your existing detection logic in

If you already have fraud rules or heuristics, you don't have to
choose between them and Ojuri's model:

- **Rules engine** ([`RULES.md`](RULES.md)) — port your existing
  hand-written rules (structuring limits, velocity caps, geo/device
  denylists) into Ojuri's PRE-stage rules, which run before the model and
  can short-circuit it, or POST-stage rules, which can override the
  model's decision. The FATF seed pack (`03_fatf_rule_pack.ts`) is a
  starting point, not a fixed policy — review and adjust the NGN-tuned
  defaults for your market.
- **Custom features** ([`FEATURES.md`](FEATURES.md)) — if your existing
  system computes signals the base 64-feature catalogue doesn't (a
  proprietary risk score, an internal denylist flag, a scheme-specific
  velocity window), add them via the adopter overlay
  (`models/feature-catalog.adopter.json`) rather than forking the
  catalogue. Retrain after any overlay change — `feature_schema_version`
  is enforced at model load.

## Bringing your historical data in

A freshly deployed Ojuri has no model tuned to your fraud patterns until
you train one on your data. Two related docs cover this, and which one
you need depends on where you are:

- **Loading labelled history** — [`ADOPTER_TRAINING.md`](ADOPTER_TRAINING.md)
  covers the four ways to get your data in: Sentinel UI upload, the bulk
  import API, direct Postgres `COPY` for technical adopters, and ongoing
  chargeback/dispute labels as they arrive.
- **Training and promoting a model on that data** —
  [`TRAINING.md`](TRAINING.md) is the operator runbook once the data is
  in: cold-start training, the McNemar significance gate, and how a new
  version gets activated.

If you have no labelled history yet, you can still run in shadow mode
against the shipped demo model while you accumulate labels through your
own chargeback/dispute process — see the "ongoing labels" section of
`ADOPTER_TRAINING.md`.

## Auth: two different credentials for two different callers

- **Your transaction pipeline** authenticates with an API key
  (`X-Api-Key: fdk_<prefix>_<secret>`), issued via
  `POST /v1/admin/api-keys`. This is what `/v1/predict` expects when
  `RDA_REQUIRE_API_KEY=true`. See [`AUTH.md`](AUTH.md).
  **The shipped default is `false`**, which leaves `/v1/predict` open to any
  caller that can reach the process. That is intentional so a fresh checkout
  works, and it is why RDA refuses to boot under `NODE_ENV=production` while
  the unsafe defaults are still in place. Set it to `true` and issue a key
  before the service is reachable from anywhere but your own host.
- **Your fraud-ops team** logs into Sentinel with a username/password and
  gets a JWT session. Roles and permissions are separate from API keys —
  see [`AUTHZ.md`](AUTHZ.md) for the permission catalogue and how to
  scope a role to, say, review-queue access without model or rules
  admin.

## What stays async and out of your hot path

`transactions.blocked` fans out to the Fraud Investigation Agent (FIA),
which generates a narrative investigation report over seconds, not
milliseconds — it never affects your `/v1/predict` response time. If you want
decision events pushed to your own case-management or SIEM tooling, subscribe
via [`WEBHOOKS.md`](WEBHOOKS.md) — HMAC-signed, with retry/backoff. The four
events are `decision.created`, `decision.overridden`, `model.activated`, and
`rule.activated`; investigation reports are not among them, so read those from
`GET /v1/reports` when a `decision.created` for a blocked transaction arrives.

Note that `X-Webhook-Delivery` is regenerated per delivery attempt, so key your
deduplication on the payload's `transaction_id` or `audit_id` rather than on
that header.

## Suggested rollout sequence

1. **Shadow** `/v1/predict` against real traffic for a couple of weeks.
   Compare Ojuri's decisions to your existing system's outcomes using
   `decisionAuditLog`. Two things make the first days of that comparison
   pessimistic, and neither is a defect: PAA has not yet populated Redis, so
   early predictions fall back to default features and log a degraded-accuracy
   warning; and the shipped thresholds were tuned against the demo model, not
   your traffic. Read `championScore` as the score that drove the decision —
   `ONNX_CALIBRATION_MODE` defaults to `observe`, which records
   `calibratedScore` alongside it without letting it affect any decision.
2. **Load your historical labels** and train a model on your own fraud
   patterns rather than the shipped demo model.
3. **Tune per-segment thresholds** (`PREDICT-API.md` → `segment` field)
   with your fraud-ops team so cutoffs match your actual risk appetite
   per transaction population — no retrain needed for this step.
4. **Move to advisory**, routing `REVIEW`/`DECLINE` into your existing
   review queue. Branch on `decision_source` first: a `REVIEW` carrying
   `BREAKER_FALLBACK` means inference never ran and the verdict holds no model
   signal, so route it to your own check rather than treating it as Ojuri's
   opinion.
5. **Move to authoritative** once you trust the false-positive rate,
   and let Sentinel reviewer overrides start feeding the retrain loop.

Each step is reversible — nothing about the API changes underneath you,
only what your calling code does with the response.

## Doc map

| Question | Doc |
|---|---|
| Exact request/response shape for `/v1/predict` | [`PREDICT-API.md`](PREDICT-API.md) |
| How do I issue/rotate an API key | [`AUTH.md`](AUTH.md) |
| How do users, roles, and JWTs work | [`AUTHZ.md`](AUTHZ.md) |
| How do I load my historical labelled data | [`ADOPTER_TRAINING.md`](ADOPTER_TRAINING.md) |
| How do I train/promote a model on that data | [`TRAINING.md`](TRAINING.md) |
| How do I port my existing rules | [`RULES.md`](RULES.md) |
| How do I add a signal the base catalogue doesn't have | [`FEATURES.md`](FEATURES.md) |
| How do I read/query the decision audit trail | [`AUDIT.md`](AUDIT.md) |
| How do I get events pushed to my own systems | [`WEBHOOKS.md`](WEBHOOKS.md) |
| How does model promotion actually work | [`MODEL-REGISTRY.md`](MODEL-REGISTRY.md) |
| What's the overall system architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
