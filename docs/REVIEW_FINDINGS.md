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
| OJR-41 | MED  | ML            | Label-volume watermark resets to process start on restart  | FIXED  |
| OJR-42 | MED  | Deployment    | dev compose omits MLA_SERVICE_TOKEN → registration 401     | FIXED  |
| OJR-43 | HIGH | Deployment    | `:ro` models mounts break versioned-artefact hot-reload    | FIXED  |
| OJR-44 | MED  | Correctness   | ACTIVE model predating boot is never applied on cold start | FIXED  |
| OJR-45 | MED  | Deployment    | Dev container serves stale `dist/` for path-aliased imports | FIXED |

## Second round — defects introduced by the first round

Three independent reviews of the fixes above found that several traded one
failure mode for a worse one. Tracked as OJR-27…40 and fixed on the same branch.

| ID     | Sev  | Area        | Finding                                                      | Status |
|--------|------|-------------|--------------------------------------------------------------|--------|
| OJR-27 | HIGH | Resilience  | Fenced-out PAA flushed stale buffers over the new leader's writes | FIXED |
| OJR-28 | HIGH | Resilience  | Lease renewal failed *open* — a Redis blip meant split brain  | FIXED  |
| OJR-29 | HIGH | Resilience  | Audit requeue turned a poison batch into a total predict outage | FIXED |
| OJR-30 | HIGH | Correctness | Dedupe inside the retry unit silently dropped retried events  | FIXED  |
| OJR-31 | HIGH | ML          | Drift watermark advanced to wall-clock, skipping labels forever | FIXED |
| OJR-32 | HIGH | Security    | `recordDurable` duplicate path could return another tenant's audit id | FIXED |
| OJR-33 | HIGH | Security    | Client-supplied timestamp could wipe a sender's velocity history | FIXED |
| OJR-34 | MED  | ML          | Drift feed scored rule and breaker rows as model predictions   | FIXED  |
| OJR-35 | MED  | Resilience  | `AUDIT_SYNC_WRITE` returned 500, not the documented 503        | FIXED  |
| OJR-36 | MED  | Correctness | Late audit patch was a guaranteed no-op in sync mode           | FIXED  |
| OJR-37 | MED  | Correctness | `featuresDefault: true` asserted defaults were used when none were loaded | FIXED |
| OJR-38 | MED  | Correctness | Hydration replay bypassed the dedupe window it relied on       | FIXED  |
| OJR-39 | MED  | Performance | Request-only rule cutoff was global, not per tenant            | FIXED  |
| OJR-40 | MED  | Resilience  | Unbounded velocity user map; no global cap on a singleton      | FIXED  |

Smaller items fixed in the same pass: retrain cooldown now covers every trigger
(not just drift); `CONTINUED` mode gained the early stopping `FRESH` got; the
drift threshold is re-anchored on restart; `unhandledRejection` no longer kills
RDA; rule expressions have node and haystack caps; legacy `in`-on-string rules
are flagged at load instead of silently never matching; `BREAKER_FALLBACK` is no
longer narrated by FIA or rendered by the SPA as a model decision; a stale
`meta.json` can no longer supply another model's calibration.

Highest-leverage cluster: **OJR-01 + OJR-02 + OJR-03** — the calibration pipeline is
disconnected from serving and mis-fit on synthetic data, and the drift monitor the
retraining story is built around never receives data.

## Residual risk after the fixes

Read these before assuming the areas are closed.

- **OJR-01 ships in observe mode.** `ONNX_CALIBRATION_MODE=observe` (the default) records
  `decisionAuditLog.calibratedScore` alongside the raw score but decides on the raw one.
  Every threshold was tuned against the raw distribution, so `enforce` moves all of them at
  once. Sequence: collect calibrated audit data → re-derive thresholds → flip.
- **OJR-07 is partial in the default pipeline, closed under `AUDIT_PIPELINE=stream`.**
  Stream mode makes the decision event (carrying the audit payload) the durable write —
  broker-acked before the response — and materialises the audit table from the topic;
  late values follow as `audit.enrichments` UPDATEs. Measurements:
  `docs/LOG_FIRST_AUDIT_PROTOTYPE.md`. The default queue pipeline narrows but keeps the
  window: batches re-queue on failure, backpressure 503s at 50k, `AUDIT_SYNC_WRITE=true`
  covers the audit row — but the Kafka publish stays post-response, so a crash in that
  gap still loses the event.

  **OJR-07 closes when stream becomes the default.** That flip changes the availability
  contract (Kafka becomes a hard dependency of `/v1/predict`), so it is reserved for a
  major release, gated on this graduation checklist:
  1. Multi-broker deploy guidance (3 brokers, `min.insync.replicas=2`) and an explicit
     broker-down policy statement (503s, by design).
  2. Consumer-lag metric with an SLO and alert — lag is audit staleness.
  3. CI suites + an integration pass with `AUDIT_PIPELINE=stream`, plus a soak run.
  4. Consumer-topology decision for multi-replica RDA (group-split works today; a
     dedicated worker mode is cleaner).
  5. Retire the LevelDB buffer for the primary-topic path once stream owns it (it still
     backs the blocked-topic and webhook async paths).
  6. Rollout/rollback runbook — the flip is clean both directions (queue writes rows
     directly; stream materialises from the topic; no backfill), stated explicitly so
     operators trust it.
- **OJR-13 raises the ceiling rather than removing it.** Retention is now time-based over
  the 30-day window; `MAX_TRANSACTIONS_PER_USER` (default 50 000) remains as a memory
  backstop. It is no longer silent — `paa_velocity_truncations_total` fires when it binds.
  Per-window rolling aggregates would remove the cap entirely but cannot reproduce
  `unique_receivers_*` or the pair metrics, which need per-receiver identity.
- **OJR-21 is directionally better, not attribution.** Gain importances are global, not
  per-transaction. `basis: MODEL_WEIGHTED` says the magnitude came from the model, not that
  the number is a Shapley value. TreeSHAP for DECLINE/REVIEW in FIA is the real answer.
- **OJR-14's dedupe window is memory-only.** It is now seeded from the hydration replay,
  which covers the overlap between the last committed Kafka offset and the newest
  persisted edge. A replay reaching further back than `PAA_DEDUPE_WINDOW_SIZE` events
  can still double-count.
- **The PAA lease is not a fencing token.** It self-fences on renewal timeout and
  discards buffered writes when fenced out, which closes the split-brain paths found in
  review. It still cannot stop a process paused past the TTL from issuing one final
  write before it notices. Making that impossible needs an epoch stamped at acquire and
  checked on every Redis/Postgres write — worth doing before PAA runs anywhere its
  process can be suspended (aggressive cgroup throttling, VM migration).
- **`AUDIT_SYNC_WRITE` puts an unbatched INSERT on the hot path.** One round-trip per
  decision, no batching. It is a throughput ceiling, not a free durability upgrade;
  a slow Postgres becomes 503s on authorization.

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

---

## Findings from live stack validation — 2026-08-06/07

Discovered while running RDA + PAA + MLA against the compose infra and exercising the
full adopter lifecycle (load test → chargeback labels → automatic retrain → registration
→ activation → hot-reload).

### OJR-41 — Label-volume watermark resets to process start `MED`

`_label_watermark = time.time()` at monitor start (main.py:658), so labels recorded while
MLA was down never count toward `LABEL_RETRAIN_THRESHOLD`. Observed live: 2,400 fresh
labels in Postgres, `labels_pending_retrain: 0` after an MLA restart. A nightly-batch
chargeback flow that lands during a deploy loses its retrain trigger entirely.

- Evidence: `mla-service/src/main.py:658, 758–766` · observed via `:9095/stats`
- Suggested direction: initialise the watermark from the last completed retrain
  (`retrainRuns` / `mlaSettings`), not process start.

### OJR-42 — dev compose omits MLA_SERVICE_TOKEN `MED`

`docker-compose.yml` passes `MLA_SERVICE_TOKEN` to every prod RDA service;
`docker-compose.dev.yml` does not, so in the documented dev flow MLA's registration
bridge gets 401 (`Invalid or expired token`) and every trained model requires manual
registration. Observed live on a label-volume retrain.

- Evidence: `docker-compose.dev.yml` (no `MLA_SERVICE_TOKEN`) vs `docker-compose.yml:66`
- Suggested direction: add the env passthrough to `rda-dev`.

### OJR-43 — `:ro` models mounts break versioned-artefact hot-reload `HIGH`

All four RDA services (3 prod + dev) mount `./models:/app/models:ro`, but
`applyActiveVersion` copies the versioned artefact into the canonical `MODEL_PATH`
(`copyFile` + `rename`). Activating any model whose `sourceUri` is not already the
canonical path fails with `EROFS`; the previous model keeps serving (fail-safe holds) but
registry-driven hot-reload can never complete in the shipped topology. Only the legacy
`cp` -into-canonical flow works read-only, because `resolved === modelPath` skips the copy.

- Evidence: `docker-compose*.yml` models mounts · `src/shared/onnx/onnx.service.ts:550–556` ·
  observed live: `EROFS: read-only file system, copyfile '/app/models/versions/v1.0/model.onnx'`
- Suggested direction: load directly from the resolved versioned path and treat the
  canonical copy as best-effort (warn on EROFS), or mount `models/` writable for RDA.

### OJR-44 — ACTIVE model predating boot is never applied `MED`

The registry's first `reload()` runs before `OnnxService` subscribes to `onActiveChange`,
and later reloads see no change — so on cold start RDA serves whatever `MODEL_PATH`
contains even when the registry says a different version is ACTIVE. Observed live: after
an rda-dev restart with v1.0 ACTIVE, no `activeChange` fired until the status was cycled
RETIRED → ACTIVE.

- Evidence: `src/shared/onnx/onnx.service.ts:385–429` · `model-registry.service.ts:88–127`
- Suggested direction: after subscribing, explicitly apply `registry.getChampion()` when
  its version/sourceUri differs from the loaded artefact (mirror the existing initial-
  shadow handling).

### Validation notes (not defects)

- Load test: 2,000 requests @16 concurrency, all HTTP 200, p50 28.9 ms / p95 51.7 / p99
  84.5, ~516 RPS, zero breaker fallbacks (pre-fix contended baseline: p99 295 ms).
- Warm pass: 0/400 decisions on default features — PAA → Redis → RDA loop closed.
- PAA consumed exactly 2,000/2,000 (dedupe correct); leader-lease handover observed live
  on nodemon restart (waiter acquired 1 s after the holder released).
- OJR-01/21 verified end-to-end: `calibratedScore` recorded on audit rows in observe
  mode while decisions stay on the raw score; response reason codes carry
  `basis: MODEL_WEIGHTED` after activation.
- The calibration probe correctly refused a weak retrained model (gap 0.10 < 0.15 →
  `/readyz` DOWN, old model kept serving); context-sensitivity gap fell 0.9998 → 0.0372
  with the new context-dropout training.
- Config residue: `mla-service/.env:26` still pins `DRIFT_F1_THRESHOLD=0.92`, overriding
  the branch's 0.4 fallback until the first champion-relative re-anchor.
- Measured: 30/200 early-PRE audit rows lost their late feature/reason-code patch to the
  batch flush race (the documented, metric-counted tradeoff — ~15% at this load shape).

---

## OJR-41…44 fixes and verification — 2026-08-07

All four verified live on the running stack after the fix; all four test suites re-run
green (RDA 210, PAA 27, MLA 79, FIA 12).

- **OJR-41** — `_label_watermark` now initialises from the last `succeeded` row in
  `retrainRuns` (`_last_retrain_epoch()`), not process start. Verified: 2,400 labels
  stamped while MLA was down → `labels_pending_retrain: 2400` on the first check after
  restart (previously 0).
- **OJR-42** — `MLA_SERVICE_TOKEN` passthrough added to `rda-dev` in
  `docker-compose.dev.yml`. Verified: token present in the container; a service-token
  `GET /v1/admin/models` returns 200.
- **OJR-43** — the canonical-copy step in `applyActiveVersion` is now best-effort: on
  failure (EROFS on the `:ro` mounts is the normal case) it warns and serves the version
  artefact directly; `loadModel` takes the artefact path. Verified through the standard
  `:ro` topology: activation of `models/versions/v1.1/` logs the warn, loads from the
  version path, passes both probes, `/readyz` UP.
- **OJR-44** — `subscribeToRegistry` now applies a pre-existing champion after wiring
  listeners (mirrors the initial-shadow handling); failure keeps the canonical model
  serving. Verified: cold restart with v1.1 ACTIVE applies it at boot and re-probes.

### OJR-45 — Dev container serves stale `dist/` for path-aliased imports `MED`

`module-alias` resolves `@config/* @shared/* @utils/*` against `dist/` at runtime, and
the dev image builds `dist/` at image build time into a named volume. The dev container
runs ts-node over the mounted `src/`, but every alias-imported module actually loads the
compiled JS frozen at build time — source edits (and even container restarts) change
nothing until `dist/` is rebuilt. Observed live: three fix iterations ran old code until
`npx tsc` was run inside the container. nodemon's watcher also missed mounted-file
changes on macOS (no legacy-watch polling).

- Evidence: `docker-compose.dev.yml` dist volume comment · `package.json` `_moduleAliases`
  · observed: `dist/shared/onnx/onnx.service.js` mtime = image build time while
  `/app/src` had newer code
- Suggested direction: in the dev image, register `tsconfig-paths` only (skip
  `module-alias` when `NODE_ENV=development`), or run `tsc --watch` alongside nodemon;
  enable nodemon legacy-watch for mounted volumes.

---

## OJR-45 fix and verification — 2026-08-07

`src/register-aliases.ts` registers `module-alias` only when running compiled output
(`__filename` ends `.js`); under ts-node, `tsconfig-paths` resolves aliases to `src/*.ts`.
Either way there is exactly one module universe, preserving the singleton-identity
guarantee the alias-to-dist routing originally existed to protect. nodemon now uses
`legacyWatch` (both RDA and PAA) so host-side edits through the Docker mount are seen on
macOS.

Verified live: rda-dev boots healthy and runs current code with `/app/dist/shared`
deleted (aliases provably resolve from the mounted `src/`), and a host-side `touch`
triggers a nodemon restart. Remaining quirk (documented, not fixed): a fenced PAA exit
reads as a crash to nodemon, which waits for a file change instead of restarting.
