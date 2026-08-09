# Decision Audit Log

Every `/v1/predict` writes one immutable row to `decisionAuditLog`.
That row is the source of truth for chargeback disputes, regulator
inquiries, model evaluations, and adopter analytics.

## Why a separate log

We deliberately do **not** reuse the `transactions` table that PAA
writes to. Reasons:

- **Audit rows must outlive everything else.** Even if PAA is rebuilt
  or a tx row is purged for GDPR right-to-erasure on PII fields,
  the audit row remains as the compliance record.
- **Schema independence.** PAA owns its table; the audit log evolves
  on the RDA's own schedule.
- **Write isolation.** PAA writes in batches every N events; the
  audit log writes on the prediction path. Different latency
  budgets, different concurrency profiles.

## Schema

| Column                | Type           | Notes                                              |
|-----------------------|----------------|----------------------------------------------------|
| `id`                  | uuid (pk)      | Server-generated.                                  |
| `transactionId`       | varchar(255)   | From the request.                                  |
| `tenantId`            | varchar(255)?  | Single-tenant deployments leave this `default`.    |
| `apiKeyId`            | varchar(255)?  | Which key the call came from. `null` in dev mode. |
| `correlationId`       | varchar(255)?  | Echo of `X-Correlation-ID` (or generated).         |
| `idempotencyKey`      | varchar(255)?  | Echo of `Idempotency-Key`.                         |
| `senderId`            | varchar(255)   |                                                    |
| `receiverId`          | varchar(255)?  |                                                    |
| `amount`              | numeric(18,4)  |                                                    |
| `transactionType`     | varchar(50)?   |                                                    |
| `segment`             | varchar(100)?  | If sent in body.                                   |
| `championModelVersion`| varchar(100)   | Resolved from the model registry.                  |
| `shadowModelVersion`  | varchar(100)?  | If a SHADOW model is registered.                   |
| `championScore`       | float          | Raw ML score from the champion.                    |
| `shadowScore`         | float?         | Shadow's score, when applicable.                   |
| `threshold`           | float          | Effective threshold (per-segment > model default > env). |
| `mlDecision`          | varchar(20)    | ACCEPT / DECLINE (what the model alone would have done). |
| `finalDecision`       | varchar(20)    | ACCEPT / DECLINE / REVIEW (after rules + overrides). |
| `decisionSource`      | varchar(32)    | ML / PRE_RULE / POST_RULE.                         |
| `ruleId`              | uuid?          | If a rule fired.                                   |
| `ruleName`            | varchar(255)?  |                                                    |
| `ruleStage`           | varchar(16)?   | PRE / POST.                                        |
| `reasonCodes`         | jsonb?         | Top-N feature contributions.                       |
| `featuresSnapshot`    | jsonb?         | Snapshot of the named features.                    |
| `featuresDefault`     | bool           | `true` when Redis cache missed.                    |
| `reviewedBy`          | varchar(255)?  | Set on override.                                   |
| `reviewedAt`          | timestamp?     | Set on override.                                   |
| `overrideDecision`    | varchar(20)?   |                                                    |
| `overrideReason`      | text?          |                                                    |
| `latencyMs`           | int            | End-to-end pipeline time.                          |
| `createdAt`           | timestamp      |                                                    |
| `updatedAt`           | timestamp      | Only changes on override.                          |

## Indexes

- B-tree on `transactionId`, `tenantId`, `apiKeyId`, `senderId`,
  `finalDecision`, `createdAt`.
- **Partial index** on `("createdAt" DESC) WHERE finalDecision = 'DECLINE' AND reviewedAt IS NULL` — keeps the review-queue
  scan small as old declines are reviewed off.

## Common queries

### "Why did we decline transaction X?"

```sql
SELECT "finalDecision", "decisionSource", "ruleName", "championScore",
       "threshold", "reasonCodes"
FROM "decisionAuditLog"
WHERE "transactionId" = '550e8400-e29b-41d4-a716-446655440000';
```

### Today's decline rate by segment

```sql
SELECT segment,
       COUNT(*) FILTER (WHERE "finalDecision" = 'DECLINE') * 1.0 / COUNT(*) AS decline_rate
FROM "decisionAuditLog"
WHERE "createdAt" >= date_trunc('day', now())
GROUP BY segment;
```

### Reviewer override rate this week

```sql
SELECT "reviewedBy",
       COUNT(*) FILTER (WHERE "overrideDecision" <> "finalDecision") AS overrides,
       COUNT(*) AS total_reviewed
FROM "decisionAuditLog"
WHERE "reviewedAt" >= now() - interval '7 days'
GROUP BY "reviewedBy";
```

### Champion vs shadow agreement

```sql
SELECT
  CASE WHEN "championScore" >= threshold THEN 'DECLINE' ELSE 'ACCEPT' END AS champion,
  CASE WHEN "shadowScore"   >= threshold THEN 'DECLINE' ELSE 'ACCEPT' END AS shadow,
  COUNT(*) AS n
FROM "decisionAuditLog"
WHERE "shadowScore" IS NOT NULL
GROUP BY 1, 2;
```

### Reasons we declined: most-common code today

```sql
SELECT (code->>'code') AS reason_code, COUNT(*) AS n
FROM "decisionAuditLog",
     LATERAL jsonb_array_elements("reasonCodes") AS code
WHERE "finalDecision" = 'DECLINE'
  AND "createdAt" >= date_trunc('day', now())
GROUP BY 1
ORDER BY n DESC
LIMIT 10;
```

## Reviewer overrides

```bash
curl -X POST http://localhost:3000/v1/decisions/<auditId>/override \
  -H "X-Api-Key: fdk_..." \
  -H "Content-Type: application/json" \
  -d '{ "decision": "ACCEPT", "reviewer": "analyst-7", "reason": "Customer verified on call" }'
```

Effects:

1. Updates `overrideDecision`, `overrideReason`, `reviewedBy`,
   `reviewedAt` on the audit row.
2. Fires the `decision.overridden` webhook.
3. Does **not** mutate `finalDecision` — that field always reflects
   the platform's automated outcome; the override is its own column
   so you can compute "how often do humans disagree with the model?".

## Retention

There is no built-in purging job. Adopters with retention obligations
should run their own:

```sql
DELETE FROM "decisionAuditLog"
WHERE "createdAt" < now() - interval '7 years';
```

A 7-year horizon is typical for payments; tighter horizons (90 days
or 1 year) are common where the audit log is supplemented by a
separate cold archive.

## Failure isolation

There are two layers here, and they behave differently.

**A single failed write is swallowed.** `DecisionAuditService.record()`
catches the error, logs it, increments an audit-write-failure metric and
returns `{ kind: "failed" }`. That row is lost. One bad write must not
take down live predictions.

**A sustained outage is not.** The hot path doesn't call `record()`
directly — it calls `enqueue()`, which buffers to a background queue. If
Postgres stays down the queue fills, and at `AUDIT_QUEUE_CAPACITY`
(default 50,000) `enqueue()` raises `AuditQueueBackpressureError`, which
the route maps to **HTTP 503**. That is deliberate: losing one row to a
blip is acceptable, silently losing the whole audit trail while happily
returning decisions is not.

So the honest summary is *best-effort per row, fail-loud in aggregate*.

If you need zero-loss auditing, set `AUDIT_PIPELINE=stream`. The decision
event then carries the full audit payload and is published to Kafka with
an awaited `acks=all` send **before** the response, and a consumer
materialises this table from the topic — so durability no longer depends
on Postgres being reachable at decision time. See
[`LOG_FIRST_AUDIT_PROTOTYPE.md`](LOG_FIRST_AUDIT_PROTOTYPE.md) for
measurements and the remaining gaps. `AUDIT_SYNC_WRITE=true` is the
simpler middle ground: persist before responding, at a latency cost.
