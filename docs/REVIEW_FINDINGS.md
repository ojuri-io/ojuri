# Code review findings — 2026-08-06

Tracker for the defects and gaps identified during the line-by-line architecture review
(companion to the "06 · Findings" tab in [`docs/how-ojuri-works.html`](how-ojuri-works.html)).
Every finding was verified directly against the source at the referenced `file:line`.
Fix directions are suggestions from the review, not commitments.

Statuses: `OPEN` · `IN PROGRESS` · `FIXED (#PR)` · `WONTFIX (reason)`

## Summary

All 21 were verified against source and fixed on `fix/review-findings-2026-08`.
Five further defects found while validating them are tracked as OJR-22…26.

| ID     | Sev  | Area          | Finding                                                    | Status |
|--------|------|---------------|------------------------------------------------------------|--------|
| OJR-01 | HIGH | ML            | Isotonic calibrator never runs in production               | FIXED  |
| OJR-02 | HIGH | ML            | Calibration split carved after SMOTE                       | FIXED  |
| OJR-03 | HIGH | ML            | Drift detection starved — no labelled events ever published | FIXED |
| OJR-04 | MED  | ML            | Cross-validation leakage through SMOTE                     | FIXED  |
| OJR-05 | MED  | ML            | Drift threshold 0.92 vs realistic F1 ~0.55 → retrain storm | FIXED  |
| OJR-06 | HIGH | Resilience    | Fail-closed breaker + contention = mass-decline amplifier  | FIXED  |
| OJR-07 | HIGH | Resilience    | No outbox — acknowledged decisions can vanish              | PARTIAL |
| OJR-08 | MED  | Resilience    | Errors burn the transaction_id for 24 h                    | FIXED  |
| OJR-09 | MED  | Resilience    | Segment thresholds silently detach on model activation     | FIXED  |
| OJR-10 | MED  | Resilience    | PAA singleton guard detects but doesn't fence              | FIXED  |
| OJR-11 | HIGH | Performance   | PAA `% 100` recompute trigger has no time gate             | FIXED  |
| OJR-12 | HIGH | Performance   | MAX_GRAPH_NODES is a soft cap — unbounded growth to OOM    | FIXED  |
| OJR-13 | MED  | Performance   | Velocity ring-buffer truncation skews high-velocity users  | FIXED  |
| OJR-14 | MED  | Performance   | At-least-once + in-memory state = double counting in PAA   | FIXED  |
| OJR-15 | MED  | Performance   | Shadow scoring awaited on the response path                | FIXED  |
| OJR-16 | LOW  | Performance   | PRE rules evaluated after feature load                     | FIXED  |
| OJR-17 | LOW  | Performance   | Hot-swap copies model file synchronously on the event loop | FIXED  |
| OJR-18 | LOW  | Correctness   | Calibration probe hardcodes 64-dim fallback                | FIXED  |
| OJR-19 | LOW  | Footgun       | Rules evaluator coercion quirks (`in` on strings, NaN)     | FIXED  |
| OJR-20 | LOW  | Footgun       | FIA poison messages dropped permanently (no DLQ)           | FIXED  |
| OJR-21 | LOW  | Footgun       | Reason codes are model-independent hand-set weights        | FIXED  |
| OJR-22 | HIGH | ML            | `fraud_label` falsy-collapse discards every False label    | FIXED  |
| OJR-23 | LOW  | ML            | Early stopping advertised in logs but never configured     | FIXED  |
| OJR-24 | MED  | Resilience    | Audit flush drops whole batches with no retry              | FIXED  |
| OJR-25 | MED  | Performance   | Cap-driven graph prune rescans every node per insert       | FIXED  |
| OJR-26 | LOW  | Correctness   | Readiness probe vectors use hardcoded catalogue indices    | FIXED  |

Highest-leverage cluster: **OJR-01 + OJR-02 + OJR-03** — the calibration pipeline is
disconnected from serving and mis-fit on synthetic data, and the drift monitor the
retraining story is built around never receives data.

## Residual risk after the fixes

Read these before assuming the areas are closed.

- **OJR-01 ships in observe mode.** `ONNX_CALIBRATION_MODE=observe` (the default) records
  `decisionAuditLog.calibratedScore` alongside the raw score but decides on the raw one.
  Every threshold was tuned against the raw distribution, so `enforce` moves all of them at
  once. Sequence: collect calibrated audit data → re-derive thresholds → flip.
- **OJR-07 is partial.** Failed audit batches now re-queue instead of being dropped, and
  `AUDIT_SYNC_WRITE=true` gives persist-before-respond for compliance deployments (a write
  failure returns 503 rather than acknowledging an unauditable decision). A true
  transactional outbox — one write covering the audit row *and* the Kafka event — is still
  outstanding, so the default path retains a small crash window between the response and
  the `setImmediate` publish.
- **OJR-13 raises the ceiling rather than removing it.** Retention is now time-based over
  the 30-day window; `MAX_TRANSACTIONS_PER_USER` (default 50 000) remains as a memory
  backstop. It is no longer silent — `paa_velocity_truncations_total` fires when it binds.
  Per-window rolling aggregates would remove the cap entirely but cannot reproduce
  `unique_receivers_*` or the pair metrics, which need per-receiver identity.
- **OJR-21 is directionally better, not attribution.** Gain importances are global, not
  per-transaction. `basis: MODEL_WEIGHTED` says the magnitude came from the model, not that
  the number is a Shapley value. TreeSHAP for DECLINE/REVIEW in FIA is the real answer.
- **OJR-14's dedupe window is memory-only.** It covers a rebalance or a producer-buffer
  replay, not a cold boot; after a restart, replayed events can double-count until
  hydration completes.

---

## ML correctness

### OJR-01 — Isotonic calibrator never runs in production `HIGH`

`trainer.py` uses `calibrator.transform()` only to compute validation metrics; the ONNX
converter converts the booster only; RDA reads raw `probabilities[1]`. `calibrator.npz`
is dead weight at inference — reported Brier is calibrated, served scores are not, and
every decision threshold (0.65 default, 0.70 CASH_OUT, 0.30 TRANSFER) is tuned against a
score distribution production never emits. CLAUDE.md's claim that calibration "bakes into
the deployed booster's score distribution" does not match the code.

- Evidence: `mla-service/src/training/trainer.py:108–115` · `mla-service/src/deployment/onnx_converter.py:36–135` · `src/shared/onnx/onnx.service.ts:689–698`
- Suggested direction: either apply the isotonic mapping in RDA after ONNX output (load
  `calibrator.npz` thresholds alongside the model), or fold the mapping into the exported
  graph; until then report the uncalibrated Brier as the serving metric.

### OJR-02 — Calibration split carved after SMOTE `HIGH`

`preprocessor.preprocess()` applies SMOTE to `X_train` (preprocessor.py:141) before
`trainer._split_for_calibration()` slices 10% off it. The isotonic fit sees ~50% synthetic
fraud rate, so even if OJR-01 were fixed, the mapping would target oversampled base rates,
not real-world ones. Context-dropout rows contaminate the split the same way.

- Evidence: `mla-service/src/training/preprocessor.py:139–141` → `mla-service/src/training/trainer.py:75, 143–160`
- Suggested direction: hold out the calibration split (and the CV folds, see OJR-04)
  before any augmentation.

### OJR-03 — Drift detection starved: no labelled events are ever published `HIGH`

MLA's consumer only updates the F1/PSI windows when `fraud_label is not None`
(kafka_consumer.py:177–187) and its docstring assumes labelled events arrive on Kafka
"day 3–7". Nothing publishes them: `grep fraud_label` over RDA's entire `src/` returns
zero hits, and the only `publishAsync` site is decision-time `predict.service.ts`. Ground
truth lands in Postgres (`groundTruthFraud`) and is never re-published. In the shipped
topology the headline F1/PSI drift monitoring never fires; retrains come only from the
500-label Postgres poll and the manual trigger.

- Evidence: `mla-service/src/consumer/kafka_consumer.py:44–67, 164–187` · zero `fraud_label` references in `src/`
- Suggested direction: publish a `transactions.labeled` event when ground truth is
  recorded (review override, chargeback ingest), or have MLA poll Postgres to feed the
  drift windows the way the label-volume trigger already does.

### OJR-04 — Cross-validation leakage through SMOTE `MED`

`cross_val_score(model, X_train, y_train)` runs on the post-SMOTE training set. Synthetic
points are interpolations of real neighbours that land in other folds, inflating the
`cv_f1_mean` / `cv_f1_std` persisted in `meta.json`.

- Evidence: `mla-service/src/training/trainer.py:125–135`
- Suggested direction: CV on pre-SMOTE data with SMOTE inside each fold
  (`imblearn.pipeline.Pipeline`).

### OJR-05 — Drift threshold 0.92 vs realistic F1 ~0.55 → retrain storm (latent) `MED`

`DRIFT_F1_THRESHOLD=0.92` against a deploy floor of `MIN_DEPLOY_F1=0.3` and the repo's own
measured realistic F1 of 0.554 (IEEE-CIS). If OJR-03 is fixed, drift fires on every check;
`drift_detector.reset()` (main.py:449) refills and fires again — a perpetual retrain loop
guarded only by `retraining_in_progress`, with no cooldown.

- Evidence: `mla-service/src/config.py` · `mla-service/src/main.py:257–271, 449`
- Suggested direction: set the F1 threshold relative to the deployed model's validation F1
  (e.g. champion F1 − margin) and add a retrain cooldown.

## Resilience / architecture

### OJR-06 — Fail-closed breaker + contention = mass-decline amplifier `HIGH`

ONNX breaker: 100 ms timeout, 10% error threshold, 60 s reset, fallback `1.0`. Measured
p999 is 3.3 s at 16-concurrency, so slow inferences count as breaker failures — a load
spike can open the breaker, after which **every transaction declines for 60 s**, and every
DECLINE dual-publishes to `transactions.blocked`, flooding FIA (~1 report/min throughput).
One contention event cascades into customer-facing mass declines plus an unbounded LLM
backlog.

- Evidence: `src/shared/onnx/onnx.service.ts:64–82` · `src/v1/modules/rda/services/predict.service.ts:310–320` · CLAUDE.md reference numbers
- Suggested direction: separate timeout-failures from error-failures, degrade to REVIEW
  (not DECLINE) on breaker open, and/or suppress the blocked-topic publish when
  `decisionSource` is the breaker fallback.

### OJR-07 — No outbox: acknowledged decisions can vanish `HIGH`

The response returns, then `setImmediate` performs the Kafka publish and webhook enqueue;
the audit write is a fire-and-forget batched enqueue that deliberately swallows DB errors.
A crash in that window means a decision was returned to the client but never audited and
never published to any consumer. For a fraud audit trail, at-most-once is a compliance gap.

- Evidence: `predict.service.ts:295–308` · `src/shared/audit/decision-audit.service.ts:33–97`
- Suggested direction: transactional outbox (audit row + outbox row in one write, drained
  by the existing webhook-style worker), or at minimum persist-before-respond for the audit
  record.

### OJR-08 — Errors burn the transaction_id for 24 h `MED`

`reserveTransactionId()` runs before predict; a thrown error never releases the
reservation. A legitimate client retry of the same `transaction_id` gets 409 — with no
cached response to replay (response caching requires the `Idempotency-Key` path).

- Evidence: `predict.service.ts:67–79, 120–136`
- Suggested direction: release the reservation in the error path of `runAndWrap`.

### OJR-09 — Segment thresholds silently detach on model activation `MED`

`segmentThresholds` is keyed `(segment, modelVersion)` and `resolve()` looks up by the
current champion version. Activating a new version silently drops CASH_OUT 0.70 /
TRANSFER 0.30 back to the default threshold until rows are re-seeded for the new version.

- Evidence: `src/shared/models/model-registry.service.ts:158–170`
- Suggested direction: carry segment thresholds forward on activation (copy rows or make
  the version key optional), and log loudly when a segment falls back.

### OJR-10 — PAA singleton guard detects but doesn't fence `MED`

A second consumer in `pattern-analysis` triggers an ERROR log and the `paa_group_members`
gauge — but both replicas keep running, each computing PageRank/Louvain on half a graph
and writing corrupt features to Redis for RDA to consume.

- Evidence: `paa-service/src/worker.ts:269–290`
- Suggested direction: fail-stop (exit) or fence via a Redis/Postgres leader lease when a
  second member is detected.

## Performance / scale

### OJR-11 — PAA `% 100` recompute trigger has no time gate `HIGH`

`shouldUpdatePagerank()` returns true on `transactionCount % 100 === 0` regardless of
elapsed time. Full PageRank (100 iterations) + Louvain + O(k²)-per-node clustering runs
synchronously on the consumer thread — at sustained TPS on a large graph the worker
recomputes near-continuously, stalling Kafka consumption (the recompute histogram buckets
go to 10 s).

- Evidence: `paa-service/src/services/graph.service.ts:144–158, 161–210`
- Suggested direction: apply `triangleRecomputeMinIntervalMs`-style gating to the modulo
  trigger; longer term, move metric recomputes off the consume path (worker thread).

### OJR-12 — MAX_GRAPH_NODES is a soft cap `HIGH`

Cap-driven pruning only evicts nodes whose `lastSeen` is >30 days stale. If the graph hits
the cap while all nodes are recent, the prune removes nothing and `ensureNode` adds the new
node anyway — unbounded growth to OOM with no warning.

- Evidence: `graph.service.ts:78–91, 431–464`
- Suggested direction: when no stale nodes exist, evict oldest-`lastSeen` regardless of
  age (true LRU) and emit a metric when cap-driven eviction touches non-stale nodes.

### OJR-13 — Velocity ring-buffer truncation skews high-velocity users `MED`

1000-txn FIFO per user against 30-day windows: `amount_mean_30d`, `velocity_7d` etc. are
computed on a truncated tail for exactly the highest-velocity senders — the population
fraud detection cares most about.

- Evidence: `paa-service/src/services/velocity.service.ts:23, 44`
- Suggested direction: per-window counters/aggregates instead of raw record retention, or
  raise the cap with time-based eviction only.

### OJR-14 — At-least-once + in-memory state = double counting `MED`

PAA commits offsets after processing; a crash between graph/velocity update and commit
replays events into memory that already counted them (Postgres upserts are conflict-safe,
memory is not). The producer's LevelDB buffer replay creates the same exposure.

- Evidence: `paa-service/src/services/kafka-consumer.ts` · `src/shared/kafka/kafka-producer.ts:375–425`
- Suggested direction: short-horizon dedupe set of processed `transaction_id`s in PAA.

### OJR-15 — Shadow scoring awaited on the response path `MED`

The shadow promise is awaited before the audit record is built; the shadow pool is capped
at 2 sessions, so under concurrency shadow inference serialises and adds latency to every
request while a SHADOW model is deployed — for an "observational only" feature.

- Evidence: `predict.service.ts:180–195` · `onnx.service.ts:566`
- Suggested direction: record the shadow score asynchronously (audit UPDATE by id, or an
  audit-side buffer keyed by auditId) and drop the await.

### OJR-16 — PRE rules evaluated after feature load `LOW`

Request-only PRE rules (most of the FATF pack) still pay the Redis feature read — 19 ms
mean under contention — before they can short-circuit. `buildRuleContext` is also
allocated twice per request (PRE and POST).

- Evidence: `predict.service.ts:147–170, 243–263`
- Suggested direction: split PRE rules by referenced vars; evaluate request-only rules
  before `loadFeatures()`.

### OJR-17 — Hot-swap copies the model file synchronously `LOW`

`copyFileSync`/`renameSync` run on the event loop during `applyActiveVersion`. Trivial at
122 KB; a full request stall for the multi-GB models the pool-size comment contemplates.

- Evidence: `onnx.service.ts:483–487`
- Suggested direction: `fs/promises` copy + rename.

### OJR-18 — Calibration probe hardcodes 64-dim fallback `LOW`

Probe vectors use `Number(process.env.MODEL_INPUT_DIMENSION) || 64` instead of
`loadCatalog().inputDimension`. With an adopter overlay (catalogue >64) and no env
override, probe vectors are wrong-width → probe throws → `/readyz` DOWN on a healthy model.

- Evidence: `onnx.service.ts:250, 275`
- Suggested direction: derive probe dimension from the loaded catalogue.

## Minor footguns

### OJR-19 — Rules evaluator coercion quirks `LOW`

`in` on a string haystack is substring `includes()`; binary comparisons `Number()`-coerce
`undefined` → NaN → silently false. A typo'd `var` path in a rule fails silently instead of
erroring at save time.

- Evidence: `src/shared/rules/evaluator.ts:33–52, 69–78`
- Suggested direction: validate `var` paths against the known-context list at rule save
  (the rule editor already has the catalogue — see PR #109), and restrict `in` to arrays.

### OJR-20 — FIA poison messages dropped permanently `LOW`

After 3 retries the offset commits and the report is gone — no DLQ. Retry counts are
in-memory, so a restart resets them (documented as a liveness tradeoff).

- Evidence: `fia-service/src/main.py:50–56, 117–133`
- Suggested direction: publish exhausted messages to a `transactions.blocked.dlq` topic.

### OJR-21 — Reason codes are model-independent `LOW`

Hand-set baselines/weights can contradict the trained model's actual attribution, and they
are the investigator/regulator-facing explanation. Documented as a hot-path speed
tradeoff; the fidelity gap remains.

- Evidence: `src/shared/onnx/reason-codes.ts:27–40`
- Suggested direction: regenerate spec weights from model feature importances at training
  time and ship them in `meta.json`.
