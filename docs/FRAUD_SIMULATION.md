# Fraud simulation & detection benchmark

A persona-driven simulation that answers the only question that
matters: **does the platform actually catch fraud, and does the label
feedback loop make it better?** It drives a realistic population
through `POST /v1/predict` over a simulated multi-week window, feeds
chargebacks back through the labels API, lets MLA retrain, and scores
detection before vs after against known ground truth.

Run it against any deployment to benchmark your own stack, or as the
final acceptance test after configuration changes.

## How to run

```bash
# Phase 1 — baseline traffic, 14 simulated days (~54k transactions)
node scripts/fraud-sim.mjs --phase 1 --days 14 --out /tmp/sim-p1.jsonl

# Phase 2 — push the chargeback wave through POST /v1/admin/labels
# (85% of phase-1 fraud reported, cleared disputes as negatives, ~0.5%
# label noise), then let the label-volume trigger retrain and activate.

# Phase 3 — 14 more days with FRESH fraud identities (~74k transactions)
node scripts/fraud-sim.mjs --phase 3 --days 14 --out /tmp/sim-p3.jsonl

# Scorecards
python3 scripts/fraud-sim-score.py /tmp/sim-p1.jsonl
python3 scripts/fraud-sim-score.py /tmp/sim-p3.jsonl
```

Environment: `RDA_URL` (default `http://localhost:3000`), `SIM_RPS`
(default 160), `--scale 0.1` for a quick pass. Deterministic per
`(seed, phase)`; the legit population is identical across phases while
fraud cohorts are fresh per phase, so phase 3 measures generalization
to unseen accounts, not memorization.

## Population

~2,900 legitimate customers over 14 simulated days per phase:

| Persona | Share | Behaviour |
|---|---|---|
| Salary spenders | ~50% of volume | 0–2 txns/day, payday burst on the 24th–28th, favourite receivers |
| Traders | ~40% | 5–11 agent-channel txns/day, stable counterparties |
| Savers | ~5% | a few transfers per week |
| Corporates | ~1% | large transfers (₦200k–5M), authenticated, mature accounts |

Fraud (~2.5% of volume), six typologies — half of ATO and structuring
deliberately **evade the FATF rule pack** so the benchmark separates
rule coverage from model skill:

| Typology | Shape |
|---|---|
| ATO (blatant / evading) | VPN + untrusted device + night-time drain; evaders stay under ₦1M with slow sessions |
| Mule rings | victims fan in → members cycle funds → agent cash-out |
| Fan-out mules | one account sprays 20–40 receivers within hours |
| Structuring (band / low) | repeated CASH_OUTs inside the FATF 4.5–5M band, or far below it |
| New-account fraud | days-old accounts, unauthenticated, fast drain |
| APP scams | genuine victims, genuine devices, authenticated — receiver-side signal only |

## Reference results (2026-07-02, single workstation)

128,302 scored transactions, 0 errors, ~160 RPS sustained. Stack:
merged 1.2.0 branches, FATF rule pack only (demo rules disabled),
`review_margin=0.08`, shipped PaySim model as the cold start.

**Phase 1 — cold model.** Rules carry everything; the ML contributes
almost nothing on a distribution it never saw:

| Metric | Value |
|---|---|
| Fraud caught (DECLINE or REVIEW) | 34.2% (560/1,638) |
| Fraud auto-declined | 2.2% |
| Legit false-positive rate | 0.0% |

**Phase 2 — 3,395 labels through `POST /v1/admin/labels`** → label-volume
trigger fired → temporal-split retrain → binding gate (incumbent F1
0.425 vs candidate 0.958 on held-out future data) → calibrator
persisted → operator activation → hot-swap with calibration probe.

**Phase 3 — retrained model, fresh fraud identities:**

| Metric | Cold | Retrained |
|---|---|---|
| Fraud caught (DECLINE or REVIEW) | 34.2% | **98.8%** |
| Fraud auto-declined | 2.2% | **65.9%** |
| Legit false-positive rate | 0.0% | 1.1% |
| Flag precision | 100% | 67.6% |

Per typology (% caught, and what caught it):

| Typology | Cold | Retrained | Credit |
|---|---|---|---|
| APP scams | 0% | 98.3% | ML |
| Fan-out mules | 0% | 100% | ML |
| Ring cycles | 0.7% | 100% | ML |
| Ring fan-in | 0% | 83.3% | ML |
| Below-band structuring | 0% | 100% | ML |
| Ring cash-out | 62.5% | 100% | rules + ML |
| Evading ATO | 90.8% | 100% | rules + ML |
| Blatant ATO | 100% | 100% | rules |
| In-band structuring | 100% | 100% | rules |
| New-account fraud | 100% | 100% | rules + ML |

## Reading the results honestly

- Simulated fraud has cleaner signatures than real fraud — generators
  are consistent in ways criminals aren't. Treat the lift as an
  upper bound; what the benchmark *proves* is the machinery: labels →
  retrain → gate → activation → measurably better decisions, with no
  human in the loop except the activation click.
- The 1.1% FPR concentrates in corporates (5.2%) and savers (4.7%) —
  large or infrequent transactions. That is what per-segment
  thresholds are for; tune them against your own audit data.
- 67.6% flag precision at this volume ≈ ~58 analyst reviews/day —
  size `review_margin` to your queue capacity.
- Phase-3 fraud uses accounts the model never saw. Typology *shapes*
  repeat across phases, which is also true of real fraud.
