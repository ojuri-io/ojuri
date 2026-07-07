# Ojuri v1 — fraud-detection efficacy validation

**Run:** `run_id=r1`, 2026-07-06, branch `validation/efficacy-v1`, git base `1784c71`.
**Stack:** unmodified `docker compose up` (3× RDA behind NGINX :80, singleton PAA, Postgres, Redis, Kafka). No FIA/MLA profiles.
**Harness:** `efficacy-validation/` — every number below is reproducible via `run-all.sh`; each table cites scenario file, seed, and raw output. 7,673 transactions pushed, every predict response HTTP 200, 100 % audit-row join.

---

## Immediate findings (read these first)

These four findings are configuration/behaviour discrepancies serious enough to surface ahead of the track results. Each is measured, not inferred.

### F1. On a fresh `docker compose up`, no ML model is registered and no segment thresholds exist

The `00_initial_model_version` seed **silently skips** in Docker — the `db-migrate` container has no `models/` directory mounted (`db-migrate` log: *"skipping — models/fraud_model.onnx not found on disk"*). Because that seed skips, `02_segment_thresholds` also skips (it requires an ACTIVE model). Verified on the running stack: `GET /v1/admin/models` → `[]`, `GET /v1/admin/segment-thresholds` → `[]`.

Consequences on every decision an adopter sees:
- The documented per-type thresholds (CASH_OUT = 0.70, TRANSFER = 0.30, …) **do not exist**; a flat env-fallback threshold of 0.65 applies to everything.
- `model_version` is reported as the env-fallback label `"default"`; the model-registry lifecycle (CANDIDATE→SHADOW→ACTIVE) starts empty.
- RDA still loads and scores with `models/fraud_model.onnx` (baked into the RDA image), so ML decisions *do* happen — but outside the registry's governance.

### F2. The seeded demo rules dominate the shipped stack and make most of the FATF pack unreachable

Two `01_demo_rules` seeds are active in the production compose stack with the highest priorities:

- `demo: very-large amount auto-block` — PRE, priority 100: **every transaction ≥ ₦100,000 is DECLINED**, unconditionally. Fired 431 times in this run, including on payroll salaries and diaspora remittances (Track 2).
- `demo: moderate payment review` — PRE, priority 400: **every PAYMENT of ₦500–10,000 goes to REVIEW**. Fired 965 times, including on 219 of 300 airtime top-ups.

Because PRE rules short-circuit in priority order, the ≥₦100k demo rule shadows three of the five seeded FATF rules (structuring band ₦4.5–4.99M, VPN ≥₦100k, ATO ≥₦1M) and the POST untrusted-device rule (≥₦200k). **Across all 6,633 transactions in this run, no FATF rule fired even once** (the high-risk-corridor rule was not exercised — no scenario sends to IR/KP/MM/SY/BY). Rule-based detection in the shipped configuration is, in practice, two demo amount rules.

### F3. The deployed ML model is a trust-context detector, not a fraud-pattern detector

A controlled comparison across Track 3 streams (identical structure, different field coverage) shows a binary split:

| Condition | ML-scored txns | score > 0.65 |
|---|---|---|
| Bare payload (only required fields; `is_authenticated`/`device_is_trusted`/`channel`/`session` absent → 0) | 687 | **687 (100 %)** |
| Full mobile-money context (`is_authenticated=1`, `device_is_trusted=1`, channel/currency set) | 770 | **0 (0 %)** |

(Sources: `results/track3_indist`, `results/track3_shift_mix_time`, cross-tab in raw feature snapshots.)

Everything in Tracks 1 and 4 is consistent with this: fraud executed from a "trusted, authenticated" context is invisible to the model regardless of velocity, graph, or amount patterns (mule network: ML scores mean 0.0011 / max 0.0028 across all 37 fraud txns; velocity burst: 0.07–0.15; ring: ~0.002 flat), while anything lacking trust context scores ≈ 1.0. The local (uncommitted) `models/versions/v1.0/meta.json` records F1 = 0.021 / recall = 0.011 for a model of this name, but its recorded sha256 does **not** match the deployed `fraud_model.onnx` — the deployed model's training provenance is not recoverable from the repo (see Limitations).

### F4. Calendar features are computed from a mis-scaled timestamp

`src/shared/features/feature-builder.ts:243-260` multiplies `request.timestamp` by 1000, treating it as **seconds**, while the DTO contract (`predict-request.dto.ts`) validates it as **milliseconds** (and PAA consumes it as ms). Verified empirically: on 400 spec-compliant requests, the recorded `hour_of_day` snapshot disagreed with the hour of the request timestamp in **382/400 (95.5 %)** cases (the rest matched by coincidence). `hour_of_day`, `day_of_week`, `is_weekend`, `is_off_hours`, and `is_payday_window` are noise for any client that follows the documented contract.

---

## Methodology summary

- **Ground truth by construction.** Every scenario generates a deterministic stream (fixed seed, listed per table) of Nigerian mobile-money-shaped transactions; the fraud subset is fraud because the generator made it so. Field shapes follow the predict DTO; verified against `src/v1/modules/rda/dtos/predict-request.dto.ts`.
- **Public interfaces only.** Streams go through NGINX :80 → `POST /v1/predict` at ≤ 25 r/s (NGINX limit is 100 r/s). Verdicts come from the predict response; audit fields from `GET /v1/admin/audit` + the public `GET /v1/decisions/:transactionId` (feature snapshots bulk-read from Postgres with per-scenario sample verification against that public endpoint). Track 4 additionally reads (never writes) the `features:{userId}` Redis hashes RDA itself reads, and PAA's `graphMetadata` table, because no HTTP API exposes community assignments.
- **PAA feedback pacing.** PAA writes features on a 100-update/10 s batch cadence. Scenarios that depend on accumulated state insert *barriers*: wait for PAA's `/stats processedCount` to catch up, then sleep past the flush interval. This models an attacker pacing a burst over minutes; without it, compressed bursts would be scored on stale features. Velocity windows in PAA are event-time, so multi-day histories are simulated via event timestamps.
- **Flagged** = decision ∈ {REVIEW, DECLINE}. ACCEPT = pass. The stack's review margin is seeded 0, so ML can only produce ACCEPT/DECLINE; every REVIEW in this run came from a rule.
- **Attribution** uses `decision_source` (+ rule name) from the response. For ML decisions, the response's reason codes are reported but treated as heuristic (they are a z-score deviation explainer, not model attribution — see the card-testing vs velocity-burst contrast below for why this matters).

## Track 1 — fraud typology coverage

Scenario files: `scenarios/track1_*.py`. Raw: `results/track1_*/raw.jsonl.gz`.

| Scenario | Seed | Fraud txns | Recall (flagged) | Precision (flagged) | FP rate on interleaved legit | Fraud verdicts A/R/D | Time-to-first-detection |
|---|---|---|---|---|---|---|---|
| card_testing | 103 | 43 | **1.00** | 0.478 | 0.131 | 0/0/43 | fraud txn #1 |
| sim_swap_ato | 105 | 15 | **0.933** | 0.212 | 0.135 | 1/0/14 | fraud txn #1 |
| structuring | 104 | 20 | 0.40 | 0.133 | 0.130 | 12/0/8 | fraud txn #1 |
| mobile_money_ring | 101 | 24 | 0.292 | 0.109 | 0.133 | 17/0/7 | fraud txn #8 (43 min into ring, event time) |
| shared_device | 106 | 40 | 0.025 | 0.019 | 0.144 | 39/0/1 | fraud txn #28 |
| mule_network | 102 | 37 | **0.00** | 0 | 0.142 | 37/0/0 | never |
| velocity_burst | 107 | 30 | **0.00** | 0 | 0.132 | 30/0/0 | never |

Per-subpattern breakdown (same raw files):

| Scenario | Subpattern | Fraud txns | Recall | What this isolates |
|---|---|---|---|---|
| structuring | fatf_band (₦4.5–4.99M CASH_OUT) | 8 | 1.00 | caught — but by the **demo ≥₦100k rule**, not the FATF structuring rule it was designed for |
| structuring | sub_100k (₦90–99k CASH_OUT ×12) | 12 | **0.00** | classic under-threshold structuring is invisible |
| sim_swap_ato | over_1M / 100k_1M | 10 | 1.00 | demo ≥₦100k rule (the FATF ATO-signature rule never fired) |
| sim_swap_ato | sub_100k | 5 | 0.80 | ML declined 4/5 — the untrusted-device+VPN+3-8 s-session context, per F3 |
| mobile_money_ring | cycle1+cycle2+layering (≤₦100k) | 18 | 0.056 | ring behaviour itself is not detected |
| mobile_money_ring | cycle3 (escalated ≥₦100k) | 6 | 1.00 | demo amount rule again |
| card_testing | probe (₦100–450 ×40) | 40 | 1.00 | ML at score ≈ 0.99998 |
| mule_network | all three layers | 37 | 0.00 | ML score mean 0.0011, max 0.0028 |

**Which agent produced the signal (fraud flags only):** demo PRE rules 24 flags, ML 30 flags, FATF rules 0, POST rules 0. No decision in the entire run was attributable to a graph feature moving a score across the threshold.

**The card-testing vs velocity-burst contrast** is the cleanest evidence of what the ML layer actually keys on. Both are single-sender bursts with high `velocity_1h` (verified in feature snapshots: velocity reached 40/h in card-testing, 18/h in velocity-burst). The card-testing attacker (untrusted device, 1–5 s sessions, ₦100–450 amounts) scored 0.99998; the velocity-burst account (trusted device, normal context, ₦5–45k) scored 0.07–0.15 and was fully accepted. The response's reason codes labelled the card-testing declines "VELOCITY_1H" — the controlled contrast shows velocity was not the discriminator; trust context was. Treat reason codes as descriptive, not causal.

## Track 2 — false positives on realistic legitimate traffic

All four scenarios contain **zero fraud by construction**; every flag is a false positive. Scenario files `scenarios/track2_*.py`, raw `results/track2_*/`.

| Scenario | Seed | Legit txns | FP rate | A/R/D | Dominant cause |
|---|---|---|---|---|---|
| airtime_topups | 204 | 500 | **0.450** | 275/219/6 | `demo: moderate payment review` on ₦500–10k PAYMENTs (219 of 225 flags) |
| diaspora_remittance | 203 | 264 | **0.277** | 191/11/62 | `demo: very-large amount auto-block` on ≥₦100k remittances (62 DECLINEs) |
| payroll | 202 | 360 | **0.247** | 271/0/89 | demo ≥₦100k rule on salaries (88 of 89 DECLINEs) |
| agent_fanout | 201 | 420 | 0.043 | 402/15/3 | demo payment-review rule on bill-sized payments |

For calibration: the task brief asks for a stated blocker threshold. Taking X = 5 % (a deliberately generous bar — production mobile-money systems typically hold FP well under 1 %), **three of four legitimate patterns exceed it, two by 5–9×**. Whether 5 % is the right bar is a judgement reserved for human review; at any plausible bar, declining a quarter of payroll and remittance traffic is adoption-blocking.

Attribution: **every Track 2 false positive except 4 came from the two demo rules**, not the ML model (agent fan-out's high-velocity, high-fan-out profile — the classic "looks like a ring" pattern — produced just 1 ML flag). The actionable statement for adopters: *the out-of-the-box FP problem is the seeded demo rule pack, and it is fixable by deleting two rules; the ML layer under-flags rather than over-flags warmed, full-context traffic.*

Note the interaction with F3: Track 2 senders carry full trust context. An adopter whose integration omits `is_authenticated`/`device_is_trusted`/`channel` (all optional fields) would instead see the Track 3 bare-payload behaviour — **100 % of traffic flagged**.

## Track 3 — calibration under distribution shift

Streams of 900 txns, 2 % fraud (8× amount multiplier), scenario files `scenarios/track3_*.py`. "In-distribution" is a **proxy** (see Limitations): lognormal(8,2) amounts + PaySim type mix + bare payloads, per the two training-data generators found in the repo.

| Stream | Seed | Legit A/R/D | Legit FP rate | ML score on legit (p50 / mean, ML-scored only) | Fraud recall |
|---|---|---|---|---|---|
| indist (proxy) | 301 | 0/169/713 | **1.000** | 1.000 / 0.9996 | 1.00 |
| shift_amounts (NG amounts, bare payload) | 302 | 0/192/686 | **1.000** | 1.000 / 0.9996 | 1.00 |
| shift_mix_time (NG amounts + type mix + business hours + full context fields) | 303 | 755/83/42 | **0.142** | 0.000 / 0.0004 | 0.25 |

Deltas:
- indist → shift_amounts (amount scale only): **no delta.** The model does not respond to the amount-distribution shift the docs describe.
- indist → shift_mix_time (context fields + type mix + timing): FP 1.000 → 0.142; median legit ML score 1.000 → 0.000; fraud recall 1.00 → 0.25 (and the residual 0.25 is entirely the demo amount rules — ML caught 0 of the 8×-amount fraud in the full-context stream).

So the public claim "day-1 calibration will be off for an adopter's traffic" is **true in an extreme and misdirected form**: the miscalibration axis is *optional-field coverage*, not the amount/type/time distributions. A bare-payload integrator gets a 100 % flag rate; a full-payload integrator gets a model that flags almost nothing, including the fraud. Both endpoints were measured; both are far from a calibrated day-1 baseline. (Whether the retraining loop fixes this was explicitly out of scope.)

The time-of-day shift axis could not be measured meaningfully: per F4, hour-of-day features are noise for spec-compliant timestamps in both streams.

## Track 4 — ring detection warm-up curve

Real-time scenarios (event time = wall time), background trickle keeps PAA's recompute ticking (every 100 events / 5 min). Community IDs observed read-only from PAA's `graphMetadata` (full integers) and the `features:*` Redis hashes; curves in `results/track4_*/warmup_curve.json`.

**Public claim under test:** velocity signals immediate; small dense rings surface at 5–60 minutes; community assignments stabilise ~24 h.

| Scenario | Seed | Ring | First observation where all members share one community | Stability afterwards |
|---|---|---|---|---|
| ring5 | 401 | 5 nodes, 1 cycle/round × 6 | **+74 s** (after round 1 — first recompute following the first full cycle) | shared at all 13 subsequent ticks; one collective relabel (all 5 moved together) at +368 s |
| ring8_dense | 402 | 8 nodes, out-degree 3 × 4 rounds | **+176 s** (after round 2; round 1 split 2 communities) | shared at all 7 subsequent ticks, no churn |
| community_stability | 403 | 5 nodes, static after 2 formation cycles | at the **first observation** (a single 5-edge cycle sufficed) | 14 ticks / ~38 min: **zero churn**, membership or label |

- **Community formation is faster than the public claim** — 1–3 minutes, not 5–60 (on a small graph; scale behaviour untested).
- **Churn:** no member-level churn observed within runs; label values did change collectively (whole ring re-numbered together), so **community IDs are usable as within-tick grouping keys, not as stable identifiers across ticks** — consistent with the known Louvain non-determinism.
- **But the community signal never reaches a decision.** Ring members' ML scores stayed at 0.0008–0.005 through every round of every ring scenario (`results/track4_ring5/raw.jsonl.gz`); ring transaction recall was 0.033 (ring5, 1/30 — a single ML decline in round 6) and 0.031 (ring8). The `graph_community_id` feature is written, read, and fed to the model — and the model does nothing with it. **PAA "detects" the ring in its feature store within minutes; Ojuri the product never acts on it.**

## Summary: what the shipped stack detects and misses

**Detected reliably:** card-testing-shaped bursts (untrusted device + tiny amounts), SIM-swap/ATO-shaped context (untrusted device + VPN + short session), and any fraud ≥ ₦100,000 (via a demo rule that equally declines legitimate payroll/remittances).

**Missed entirely or almost entirely:** mule networks (0 %), velocity anomalies from trusted devices (0 %), sub-threshold structuring (0 %), shared-device clusters (2.5 % — no shipped feature consumes `device_fingerprint`, so this typology is undetectable by design, not by tuning), fraud rings below the amount-rule threshold (5.6 % on ring behaviour itself).

**The launch-narrative attribution does not hold in the shipped configuration:** ring/graph detection (PAA) produces features but zero decisions; the FATF rule pack produces zero decisions; the ML layer detects integration context rather than fraud patterns; the two demo amount rules do most of the flagging, on fraud and legitimate traffic alike.

## Relationship to the 128k fraud-simulation benchmark

[`docs/FRAUD_SIMULATION.md`](../docs/FRAUD_SIMULATION.md) reports 34.2 % of fraud caught cold → 98.8 % after one label-driven retrain at 1.1 % FPR. That result and this report do not contradict each other; they answer different questions under different configurations:

- **Its cold-model phase corroborates this report.** Phase 1 of the simulation ("rules carry everything; the ML contributes almost nothing") matches Track 1 per-typology: fan-out mules 0 % vs our mule network 0 %, ring cycles 0.7 % vs our ring behaviour 5.6 %, below-band structuring 0 % vs our 0 %, ATO caught by rules in both.
- **Its headline number is post-retrain.** Running the retraining loop was explicitly out of scope here (this report quantifies the day-1 gap only). The retrained artifact from that run (`models/versions/v1.1/`, F1 = 0.992, `new_labels: 3395`) exists locally but is neither committed nor deployed — the committed `fraud_model.onnx` is the cold model.
- **Its reference run used a tuned configuration:** demo rules *disabled* and `review_margin=0.08`. This report measures the shipped defaults (demo rules active, review margin 0), which is why its FP rates (0.0–1.1 %) and Track 2's (4.3–45 %) differ — the delta *is* finding F2.

## Limitations and run conditions

1. **Model provenance is unverifiable.** The deployed `fraud_model.onnx` (sha256 `62bd51…`) matches no committed metadata; the local v1.0 meta records a different hash. "In-distribution" in Track 3 is therefore a documented proxy, and no claim in this report relies on the meta's F1/recall figures.
2. **Host was CPU/memory-saturated during the run** (flagged by the operator mid-run). This does not affect verdicts — decisions are deterministic given features — but `latency_ms` values in raw output are not performance data, and PAA feature-write lag may have been marginally larger than on an idle host (mitigated by barriers; `barrier_misses=0` across all 17 scenarios).
3. **Single run per scenario.** Streams are seed-deterministic, but PAA state accumulates across scenarios (documented order in `run-all.sh`) and Louvain labels are unseeded. Track 4 measures within-run label churn; cross-run variance was not measured.
4. **Barriers model a paced attacker.** A max-speed burst (all 40 card tests inside one 10 s flush window) would be scored on staler features than measured here; the measured numbers are the *favourable-to-Ojuri* pacing.
5. **The FATF high-risk-corridor rule was not exercised** (no scenario transacts with IR/KP/MM/SY/BY); it is the one seeded FATF rule that could fire below ₦100k.
6. Track 3 fraud is amount-outlier-shaped only (matching the synthetic labeler's construction); recall numbers there measure amount-outlier sensitivity, not typology coverage (that is Track 1's job).

## Reserved for human review

The following judgements are required by these numbers and are explicitly **not** made in this report:

1. Whether 0 % recall on mule networks and trusted-device velocity abuse is disqualifying for the launch narrative, or acceptable for a v1 with the retraining story attached.
2. What false-positive rate is acceptable for a Nigerian mobile-money operator (this report used an illustrative X = 5 %; airtime = 45 %, remittance = 27.7 %, payroll = 24.7 % against it).
3. Whether the demo rule pack should ship enabled in the production compose file at all, and whether its NGN thresholds (₦100k ≈ common salary/remittance territory) were reviewed against any market data.
4. Whether the deployed ONNX model should be replaced/retrained before any adopter-facing claim of ML-based detection is repeated (and whether the better-scoring local v1.1 artifact was *meant* to be the deployed one).
5. Whether "PAA surfaces rings in minutes" can be claimed publicly while no decision pathway consumes the community signal.
6. Whether the F1–F4 findings warrant correcting or withdrawing specific statements in the LinkedIn/X/carousel launch materials (this report measured behaviour; mapping to individual public statements is an editorial call).
7. The priority of fixing F4 (calendar features) given that the deployed model may not weight those features anyway — needs a model owner's judgement.
