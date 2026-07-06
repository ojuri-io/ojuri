# Efficacy validation

Measures whether the **shipped, unmodified** Ojuri stack (`docker compose up`)
produces fraud verdicts a fraud analyst would consider correct, on realistic
Nigerian mobile-money transaction streams with ground truth known by
construction. Companion to the codebase audit (code soundness) and the
adversarial persona QA (typology evasion) — this asks only: *what does the
stack actually decide?*

The primary deliverable is [`report.md`](report.md). Every number in it comes
from a script in this directory and cites its scenario file, seed, and raw
output.

## How to reproduce

```bash
# from the repo root, on a machine with Docker + Python 3.9+
./efficacy-validation/run-all.sh
```

`run-all.sh` brings up the unmodified compose stack, waits for readiness, and
runs all 17 scenarios (~1.5-2.5 h wall time depending on host load, dominated
by PAA-flush barriers and Track 4 real-time observation). Exit 0 means the harness completed; Ojuri
missing fraud is a *finding*, never a harness failure. Results land in
`results/<scenario>/`:

- `raw.jsonl.gz` — one record per transaction: request body, ground truth,
  predict response, joined audit fields (feature snapshot subset)
- `metrics.json` — computed recall/precision/FP-rate/attribution/etc
- `meta.json` — run id, seed, git SHA, timestamps, barrier stats
- `observations.jsonl` (Track 4 only) — timestamped Redis/Postgres snapshots
  of ring members' graph features

## Determinism and its limits

Every scenario is generated from a fixed seed (in the scenario file). Given
the same `(seed, run_id, anchor)`, the stream content — amounts, structure,
ordering, actor roles — is byte-identical. Three things are inherently not
fixed, all documented per scenario:

1. **Identifiers and timestamps** embed `run_id` / the run's anchor time,
   because the stack holds a 24 h idempotency reservation per
   `transaction_id` — replaying identical IDs returns 409s, and event
   timestamps must sit inside PAA's 30-day wall-clock retention.
2. **Louvain community IDs** in PAA are unseeded (upstream
   `graphology-communities-louvain` behaviour). Track 4's
   `community_stability` scenario measures the churn instead of hiding it.
3. **The stack accumulates state across scenarios** (shared graph, shared
   Postgres). Scenarios use disjoint user namespaces, so velocity/pair/
   community structure is isolated, but global graph metrics (PageRank
   normalisation, hub percentile) see the union. This mirrors production,
   where one tenant's traffic shares the graph with everything before it.

## Ground rules applied

- No thresholds invented: the stack decides with whatever `docker compose up`
  seeds (all 9 demo+FATF rules active, flat 0.65 ML threshold — see report
  finding on the skipped model-registry seed).
- Only public interfaces are used to *drive* the stack (NGINX :80). Track 4
  additionally *reads* (never writes) the `features:{userId}` Redis hashes —
  the exact documented interface RDA reads — and PAA's `graphMetadata`
  Postgres table, because no public HTTP API exposes community assignments.
- Admin API access (audit-log join) follows the normal operator flow: the
  seeded admin password is scraped from the `db-migrate` container logs and
  rotated to a harness-owned password on first login. On an already-rotated
  stack the harness reuses its own password.
- The harness asserts HTTP 200 on every predict call and aborts (non-zero)
  otherwise, so no metric is computed over rate-limit rejects or duplicate
  short-circuits. Send rate is throttled to 20 r/s, well under the NGINX
  100 r/s per-IP limit.

## What was NOT tested

- Retraining-loop improvement (Track 3 measures the day-1 gap only)
- FIA narrative reports (profile-gated service; not part of default compose)
- Production-scale load (>1000 TPS) or latency (host was CPU/memory-saturated
  during the recorded run; `latency_ms` fields in raw output are not
  performance data)
- Sentinel UI beyond nothing (no UI assertions in this harness)
- Public fraud datasets (IEEE-CIS etc.) — out of scope per the task brief

## Layout

```
scenarios/   deterministic stream generators (one file per scenario, seed at top)
harness/     runner (push/collect/join/metrics), HTTP client, Redis/PG observer
results/     raw outputs + computed metrics, one directory per scenario
run-all.sh   end-to-end reproduction
report.md    findings
```
