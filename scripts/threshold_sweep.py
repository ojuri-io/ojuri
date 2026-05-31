"""
Threshold sweep on a saved harness run.

The current FRAUD_THRESHOLD=0.65 is an env default with no analysis
behind it. Given a harness JSON (per-decision capture with persona +
fraud_probability), compute precision / recall / FP rate at every
candidate threshold and surface the threshold that meets a target
operating constraint.

Run:
  python scripts/threshold_sweep.py reports/load-test-postfix.json
  python scripts/threshold_sweep.py reports/load-test-postfix.json --target-fp-rate 0.001
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


# Personas where a flag is desirable (TP if score >= threshold)
FRAUD_PERSONAS = {
    "mule_layering",
    "card_testing",
    "account_takeover",
    "smurfing",
    "velocity_burst",
    "geo_anomaly",
    "new_account_drain",
    "romance_scam",
}
LEGIT_PERSONAS = {"legit", "background"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("json_path", type=Path)
    p.add_argument(
        "--target-fp-rate",
        type=float,
        default=0.005,
        help="Maximum acceptable false positive rate on legit + background. "
        "Default 0.5%% — adjust to whatever the business will tolerate.",
    )
    p.add_argument(
        "--step",
        type=float,
        default=0.05,
        help="Threshold sweep granularity (default 0.05).",
    )
    args = p.parse_args()

    with args.json_path.open() as f:
        data = json.load(f)
    decisions = data["decisions"]

    fraud_scores = []
    legit_scores = []
    per_persona_scores = defaultdict(list)
    for d in decisions:
        prob = d.get("fraud_probability")
        if prob is None:
            continue
        persona = d["persona"]
        per_persona_scores[persona].append(prob)
        if persona in FRAUD_PERSONAS:
            fraud_scores.append(prob)
        elif persona in LEGIT_PERSONAS:
            legit_scores.append(prob)

    print(f"Loaded {len(fraud_scores)} fraud + {len(legit_scores)} legit decisions")
    print()
    print(f"{'threshold':>10}  {'recall':>8}  {'precision':>10}  {'FP rate':>9}  {'F1':>6}  {'TP':>5}  {'FP':>5}  {'FN':>5}  {'TN':>6}")
    print("-" * 88)

    best_for_target = None
    sweep_rows = []
    t = 0.05
    while t <= 0.96:
        tp = sum(1 for s in fraud_scores if s >= t)
        fn = len(fraud_scores) - tp
        fp = sum(1 for s in legit_scores if s >= t)
        tn = len(legit_scores) - fp
        recall = tp / (tp + fn) if (tp + fn) else 0
        precision = tp / (tp + fp) if (tp + fp) else 0
        fp_rate = fp / (fp + tn) if (fp + tn) else 0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0
        print(f"{t:>10.2f}  {recall:>8.4f}  {precision:>10.4f}  {fp_rate:>9.4f}  {f1:>6.4f}  {tp:>5}  {fp:>5}  {fn:>5}  {tn:>6}")
        sweep_rows.append((t, recall, precision, fp_rate, f1, tp, fp, fn, tn))
        if fp_rate <= args.target_fp_rate and (best_for_target is None or recall > best_for_target[1]):
            best_for_target = (t, recall, precision, fp_rate, f1)
        t += args.step

    print()
    if best_for_target:
        t, r, p_, fpr, f1 = best_for_target
        print(f"Best threshold at FP rate ≤ {args.target_fp_rate:.4f}:")
        print(f"  threshold = {t:.2f}")
        print(f"  recall    = {r:.4f}")
        print(f"  precision = {p_:.4f}")
        print(f"  FP rate   = {fpr:.4f}")
        print(f"  F1        = {f1:.4f}")
    else:
        print(f"No threshold meets target FP rate ≤ {args.target_fp_rate:.4f}.")

    print()
    print("Per-persona median score (threshold-independent):")
    for persona, scores in sorted(per_persona_scores.items()):
        scores_sorted = sorted(scores)
        med = scores_sorted[len(scores_sorted) // 2] if scores_sorted else 0
        is_fraud = persona in FRAUD_PERSONAS
        kind = "fraud" if is_fraud else "legit"
        print(f"  {persona:<20}  n={len(scores):<5}  median={med:.4f}  [{kind}]")


if __name__ == "__main__":
    main()
