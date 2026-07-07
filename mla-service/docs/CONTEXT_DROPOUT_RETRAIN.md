# Cold-start retrain with context-field dropout

## Why

The efficacy validation (finding **F3**) measured the shipped cold-start
model as a *trust-context detector*: the same transaction scored ~1.0
with the optional context fields absent and ~0.0 with them present.
Behavioural fraud (mule networks, trusted-device velocity bursts, rings)
scored as legitimate; bare-payload integrators saw near-blanket declines.

Root cause is train-time coupling: fraud examples happened to carry
distinctive context (VPN, untrusted device, short session) while legit
examples carried trusted context, so XGBoost learned "context present =
legit, context absent = fraud" instead of behaviour.

## The fix (this change)

`DataPreprocessor` appends context-dropout copies of a fraction
(`CONTEXT_DROPOUT_FRACTION`, default 0.4) of the **training** rows with
the optional context features zeroed and labels preserved
(`CONTEXT_DROPOUT_ENABLED`, default on). The model sees each retained
pattern both with and without integration context and must find fraud
signal in behaviour/amount/graph features. Validation and test sets are
untouched, so the deployment gate still measures full-context
performance. Zeroed features: `CONTEXT_FEATURE_NAMES` in
`src/training/preprocessor.py`.

This ships the *mechanism*. A retrain must run for the deployed model to
benefit.

## Running the retrain

Needs the stack up and a behaviourally + context diverse labelled set —
the fraud-sim kit generates one:

```bash
# 1. Generate labelled traffic through the running stack (writes to Postgres)
node scripts/fraud-sim.mjs --phase 1 --days 14 --out /tmp/sim-p1.jsonl
node scripts/fraud-sim.mjs --phase 3 --days 14 --out /tmp/sim-p3.jsonl
#    push chargebacks so groundTruthFraud is populated (see docs/FRAUD_SIMULATION.md)

# 2. Retrain — context dropout is applied automatically in preprocessing
cd mla-service && source venv/bin/activate
python scripts/train_initial_model.py            # reads labelled rows, writes models/fraud_model_v1.0.onnx
```

## Acceptance gates (do not deploy unless all pass)

1. **Context-sensitivity probe** (`OnnxService`, PR #103): load the
   candidate and confirm the logged `contextSensitivityGap` drops below
   0.5 (shipped model: 0.9998). This is the direct measure that the
   degeneracy is gone.
2. **Efficacy harness** (`efficacy-validation/run-all.sh`): Track 1
   typology recall — especially `mule_network` and `velocity_burst`,
   both 0.00 on the shipped model — must materially improve, and Track 2
   false-positive rates must stay low.
3. **Deployment gate** (built in): temporal-split F1 must beat the
   incumbent on held-out future data, per the existing McNemar/gate flow.

Only if all three hold, register the candidate and flip it ACTIVE
(`POST /v1/admin/models`, then `.../status`), which hot-swaps RDA and
re-runs the probe.

## Measured trial run (2026-07-07, fraud-sim data)

A first end-to-end run on this stack, to characterise the mechanism
before a production retrain. 11,092 labelled rows (429 fraud / 10,663
legit) from the fraud-sim, `CONTEXT_DROPOUT_FRACTION=0.4`.

| Model | Context gap (gate 1) | Track-1 recall velocity / mule / ring (gate 2) |
|---|---|---|
| Shipped `default` | 0.9998 | 0.00 / 0.00 / 0.04 |
| Retrain, dropout **off** | 0.9725 | — |
| Retrain, dropout **on** | **0.0009** | 0.00 / 0.00 / 0.04 |

**What this establishes.** Gate 1 passes decisively — the dropout, not
the fresh data, closes the context gap (the no-dropout retrain on the
same rows stays at 0.97). Full-context F1 held at 0.949. **But gate 2
did not move**: the retrained model's behavioural-typology recall was
identical to the shipped model's.

The reason is the training data, not the mechanism: the fraud-sim's
fraud is context-signalled (ATO = VPN + untrusted device, new-account =
unauthenticated), so the model learns those, and context dropout makes
it robust to *missing* context — but it cannot learn velocity/graph
typologies the data does not label as fraud. Fixing the context gap is
**necessary but not sufficient** for typology coverage.

Practical consequence: the augmentation is worth shipping (it fixes a
real integration-robustness defect), but the ML only becomes a
*behavioural* detector when retrained on data where velocity- and
graph-shaped fraud is actually labelled — real accumulated chargebacks,
or a fraud-sim variant that emphasises those typologies. Until then the
behavioural rule pack (`04_behavioral_rule_pack.ts`) is what catches
velocity/fan-out fraud; the two are complementary layers, not
substitutes. The trial candidate was **not** deployed.

## Tuning

- `CONTEXT_DROPOUT_FRACTION` too high starves the model of the genuine
  fraud signal in `ip_is_vpn` / `device_is_trusted` (ATO detection drops);
  too low leaves the F3 degeneracy. 0.3–0.5 is the range to sweep against
  gate #1 and #2.
- Set `CONTEXT_DROPOUT_ENABLED=false` to reproduce the pre-fix baseline
  for an A/B on the same data.
