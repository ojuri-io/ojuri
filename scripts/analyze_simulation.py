#!/usr/bin/env python3
"""
Analyse fraud-typology-simulation output.

Reads a JSONL file (one ResultRecord per line) and produces:
  - Confusion matrix at the deployed threshold
  - Precision / recall / F1 / FPR / accuracy at multiple thresholds
  - Per-typology breakdown
  - Latency percentiles
  - Recommended thresholds for several business postures
  - Estimated $ loss exposure (given simple loss assumptions)

Usage:
    python3 scripts/analyze_simulation.py reports/sim-sequential.jsonl
    python3 scripts/analyze_simulation.py reports/sim-sequential.jsonl --base-rate 0.005
"""

import argparse
import json
import statistics
import sys
from collections import defaultdict, Counter
from pathlib import Path


def load_jsonl(p: Path):
    rows = []
    with p.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def percentile(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * (q / 100.0)
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    if f == c:
        return xs[f]
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def confusion(rows, threshold, treat_review_as_block=True):
    tp = fp = tn = fn = 0
    for r in rows:
        if r.get("status", 0) < 200 or r.get("fraud_probability") is None:
            continue
        gt = r["ground_truth"] == "FRAUD"
        # If rule short-circuited or model decided, we use the EFFECTIVE decision the system
        # would produce at this threshold. For rule decisions, decision is already set
        # regardless of model score, so we use that. For ML, we re-threshold.
        src = r.get("decision_source")
        dec = r.get("decision")
        if src in ("PRE_RULE", "POST_RULE"):
            blocked = dec == "DECLINE" or (treat_review_as_block and dec == "REVIEW")
        else:
            score = r["fraud_probability"]
            blocked = score >= threshold
        if gt and blocked: tp += 1
        elif gt and not blocked: fn += 1
        elif (not gt) and blocked: fp += 1
        else: tn += 1
    return tp, fp, tn, fn


def metrics(tp, fp, tn, fn):
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    accuracy = (tp + tn) / (tp + fp + tn + fn) if (tp + fp + tn + fn) else 0.0
    return dict(precision=precision, recall=recall, fpr=fpr, f1=f1, accuracy=accuracy)


def adjusted_precision_at_base_rate(precision_sim, recall, base_rate, sim_rate):
    """
    Project simulation precision to a realistic base rate.
    If sim has fraud rate F and observed precision P, the FPR is implicit.
    But it's cleaner to express precision in terms of recall and FPR at the
    real base rate.

    P_real = recall * base_rate / (recall * base_rate + fpr * (1 - base_rate))
    """
    # We need fpr, not precision_sim. Caller passes both.
    return None  # not used directly; use metrics+fpr below


def precision_at_base_rate(recall, fpr, base_rate):
    if recall == 0 and fpr == 0:
        return 0.0
    denom = recall * base_rate + fpr * (1 - base_rate)
    if denom == 0:
        return 0.0
    return recall * base_rate / denom


def per_typology(rows, threshold):
    by_typ = defaultdict(list)
    for r in rows:
        by_typ[r["typology"]].append(r)
    out = {}
    for typ, recs in sorted(by_typ.items()):
        valid = [r for r in recs if r.get("fraud_probability") is not None]
        gt = recs[0]["ground_truth"]
        blocked = 0
        for r in valid:
            src = r.get("decision_source")
            dec = r.get("decision")
            if src in ("PRE_RULE", "POST_RULE"):
                blocked += 1 if dec == "DECLINE" or dec == "REVIEW" else 0
            else:
                blocked += 1 if r["fraud_probability"] >= threshold else 0
        n = len(valid)
        out[typ] = dict(
            ground_truth=gt,
            n=n,
            blocked=blocked,
            rate=blocked / n if n else 0.0,
            mean_score=statistics.mean([r["fraud_probability"] for r in valid]) if valid else 0,
            median_score=statistics.median([r["fraud_probability"] for r in valid]) if valid else 0,
        )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path)
    ap.add_argument("--base-rate", type=float, default=0.01,
                    help="Realistic fraud base rate to project precision against (default 1%%)")
    ap.add_argument("--loss-per-fraud", type=float, default=2000.0)
    ap.add_argument("--friction-per-fp", type=float, default=15.0,
                    help="Average $ cost of one false positive (customer service + lost txn)")
    args = ap.parse_args()

    rows = load_jsonl(args.path)
    if not rows:
        print("no rows", file=sys.stderr)
        sys.exit(1)

    n_total = len(rows)
    n_ok = sum(1 for r in rows if r.get("status", 0) >= 200)
    n_fraud = sum(1 for r in rows if r["ground_truth"] == "FRAUD")
    n_legit = n_total - n_fraud
    deployed_threshold = next((r["threshold"] for r in rows if r.get("threshold") is not None), 0.5)

    print(f"# Independent Fraud-Typology Simulation — Results")
    print()
    print(f"Total requests : {n_total}")
    print(f"HTTP 200       : {n_ok}")
    print(f"Ground truth   : {n_fraud} fraud / {n_legit} legit  (sim base rate {n_fraud/n_total:.2%})")
    print(f"Deployed thrsh : {deployed_threshold}")
    print()

    # ---- Latency
    lats = [r["latency_ms"] for r in rows if r.get("status", 0) >= 200]
    print("## Latency (full request, through nginx)")
    print(f"  p50 = {percentile(lats, 50):.0f} ms")
    print(f"  p90 = {percentile(lats, 90):.0f} ms")
    print(f"  p95 = {percentile(lats, 95):.0f} ms")
    print(f"  p99 = {percentile(lats, 99):.0f} ms")
    print(f"  max = {max(lats):.0f} ms")
    print()

    # ---- Confusion at deployed threshold
    tp, fp, tn, fn = confusion(rows, deployed_threshold)
    m = metrics(tp, fp, tn, fn)
    print(f"## At deployed threshold ({deployed_threshold})")
    print(f"  TP={tp}  FP={fp}  TN={tn}  FN={fn}")
    print(f"  precision = {m['precision']:.3f}")
    print(f"  recall    = {m['recall']:.3f}")
    print(f"  FPR       = {m['fpr']:.4f}    ({m['fpr']*100:.2f}% of legit blocked)")
    print(f"  F1        = {m['f1']:.3f}")
    print(f"  accuracy  = {m['accuracy']:.3f}")
    print(f"  precision projected to {args.base_rate:.1%} base rate = {precision_at_base_rate(m['recall'], m['fpr'], args.base_rate):.3f}")
    print()

    # ---- Per typology
    print(f"## Per-typology breakdown at threshold {deployed_threshold}")
    pt = per_typology(rows, deployed_threshold)
    print(f"  {'typology':32} {'gt':5} {'n':>5} {'block':>6} {'rate':>6} {'mean':>6} {'med':>6}")
    for typ, d in pt.items():
        print(f"  {typ:32} {d['ground_truth']:5} {d['n']:5d} {d['blocked']:6d} {d['rate']:6.1%} {d['mean_score']:6.3f} {d['median_score']:6.3f}")
    print()

    # ---- Threshold sweep
    print("## Threshold sweep (ML decisions only — rules unaffected)")
    print(f"  {'thresh':>7} {'TP':>5} {'FP':>5} {'TN':>5} {'FN':>5} {'prec':>6} {'recall':>7} {'FPR':>7} {'F1':>6}  prec@{int(args.base_rate*100)}%")
    for t in [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.65, 0.70, 0.80, 0.90]:
        tp, fp, tn, fn = confusion(rows, t)
        m = metrics(tp, fp, tn, fn)
        pbr = precision_at_base_rate(m['recall'], m['fpr'], args.base_rate)
        print(f"  {t:7.2f} {tp:5d} {fp:5d} {tn:5d} {fn:5d} {m['precision']:6.3f} {m['recall']:7.3f} {m['fpr']:7.4f} {m['f1']:6.3f}  {pbr:6.3f}")
    print()

    # ---- Decision source breakdown
    print("## Decision source distribution")
    src = Counter(r.get("decision_source") for r in rows if r.get("decision_source"))
    for k, v in src.most_common():
        print(f"  {k:12} {v:5d}  ({v/n_total:.1%})")
    print()

    # ---- Economic projection
    tp_d, fp_d, tn_d, fn_d = confusion(rows, deployed_threshold)
    print(f"## Economic projection (assumes ${args.loss_per_fraud:.0f} avg loss per missed fraud,")
    print(f"   ${args.friction_per_fp:.2f} avg cost per false positive)")
    fraud_loss = fn_d * args.loss_per_fraud
    fp_cost = fp_d * args.friction_per_fp
    total = fraud_loss + fp_cost
    print(f"  Missed fraud cost (FN × $loss)     = ${fraud_loss:,.0f}")
    print(f"  False-positive friction cost       = ${fp_cost:,.0f}")
    print(f"  Total operating cost (sim)         = ${total:,.0f}")
    print()


if __name__ == "__main__":
    main()
