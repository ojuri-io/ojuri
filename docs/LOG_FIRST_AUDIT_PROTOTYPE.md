# Log-first audit pipeline — prototype and measurements

Branch: `proto/log-first-audit`. Prototype of replacing the in-memory audit batch queue
with a log-first design: the decision event (carrying the full audit payload) is published
to `transactions.completed` with an **awaited `acks=all`** send before the client gets the
response, and the audit table is materialised from the topic by a Kafka consumer
(`AuditStreamConsumer`, group `audit-writer`) doing batched `ON CONFLICT DO NOTHING`
inserts. Redis idempotency reservations make the at-least-once delivery safe; PAA's
dedupe window and the audit table's unique constraint absorb redeliveries.

Toggle: `AUDIT_PIPELINE=stream` (default `queue` — no behavior change unless set).

## Measurements

2,000 requests, 16-way concurrency, unique transaction ids, all responses HTTP 200,
single rda-dev replica, direct port 3000, Apple Silicon workstation. Runs interleaved
queue → stream → stream → queue to bracket run-order effects.

| Run | p50 | p95 | p99 | max | RPS |
|-----|-----|-----|-----|-----|-----|
| queue (baseline)                    | 25.3 | 43.5 | 65.2  | 95.6  | 591 |
| stream, gzip on-path (v1)           | 26.7 | 76.6 | 178.0 | 217.9 | 473 |
| stream, no compression on-path (v2) | 24.2 | 42.0 | 75.9  | 130.6 | 602 |
| queue (bracket re-run)              | 24.5 | 40.1 | 56.9  | 106.5 | 625 |

- The awaited broker ack itself is nearly free at the median: p50 parity, RPS parity.
- Per-message **gzip inside the awaited send was the entire v1 tail** — moving it off the
  durable path recovered p95 to parity. Follow-up: broker/topic-level `compression.type`
  restores wire compression without touching the hot path.
- The durability premium after tuning is **~10–19 ms at p99**, ~0 at p50/p95/RPS.
- The audit consumer materialised **2,000/2,000 rows** within seconds in every stream run;
  spot-checked rows carry score, reason codes, feature snapshot, and latency.

## What the stream mode buys

- The crash window between "client told the decision" and "any durable record exists"
  closes: an acked decision is in Kafka before the response, and the audit table follows
  from the log. (Closes the outstanding half of OJR-07.)
- Deletes two mechanisms once adopted fully: the in-memory `AuditWriteQueue` and the
  LevelDB spillover buffer for decision events.
- Audit table and downstream consumers (PAA/MLA/FIA) derive from the same stream, so they
  can no longer disagree about which decisions happened.

## Prototype gaps (to resolve before adopting)

- Shadow scores and early-PRE feature enrichment are dropped in stream mode (the payload
  is immutable once published). Options: a small enrichment event, or accept the loss.
- Kafka becomes a hard availability dependency of `/v1/predict`: broker down = 503s.
  Production needs 3 brokers with `min.insync.replicas=2`, or a documented degraded mode.
- Audit reads are eventually consistent (consumer lag); needs a lag SLO and alert.
- Events grow by the audit payload (~2–4 KB uncompressed); enable broker-side compression.
- The consumer runs inside each RDA replica; a dedicated worker (or one elected replica)
  avoids N replicas racing on the same consumer group for no benefit.
