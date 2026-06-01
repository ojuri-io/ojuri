#!/usr/bin/env python3
"""Verify each claim in the fraud-specialist verdict against raw simulation data."""

import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
import sys


def load(p):
    rows = []
    with Path(p).open() as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main():
    seq = load("reports/sim-sequential.jsonl")
    conc = load("reports/sim-concurrent16.jsonl")

    print("=" * 70)
    print("CLAIM 1: APP / romance scams 0% recall")
    print("=" * 70)
    for label, rows in [("sequential", seq), ("concurrent", conc)]:
        print(f"\n[{label}]")
        for typology in ["app_scam_purchase", "app_scam_impersonation", "romance_scam_payout"]:
            recs = [r for r in rows if r["typology"] == typology]
            scores = [r["fraud_probability"] for r in recs if r.get("fraud_probability") is not None]
            decisions = Counter(r.get("decision") for r in recs)
            print(f"  {typology:30s} n={len(recs):3d}  "
                  f"max_score={max(scores) if scores else 0:.4f}  "
                  f"mean={statistics.mean(scores) if scores else 0:.4f}  "
                  f"decisions={dict(decisions)}")
            # Verify ZERO of them crossed the 0.15 threshold
            above_15 = sum(1 for s in scores if s >= 0.15)
            print(f"  {' '*30}   above_threshold(0.15)={above_15}  (== 0% recall? {'YES' if above_15 == 0 else 'NO'})")

    print("\n" + "=" * 70)
    print("CLAIM 2: Model outputs saturated (0 or 1 only)")
    print("=" * 70)
    all_ml = [r["fraud_probability"] for r in seq
              if r.get("decision_source") == "ML" and r.get("fraud_probability") is not None]
    print(f"\nML-decision score distribution (n={len(all_ml)}):")
    buckets = [0, 0.01, 0.05, 0.10, 0.20, 0.50, 0.90, 0.99, 1.001]
    for lo, hi in zip(buckets, buckets[1:]):
        n = sum(1 for s in all_ml if lo <= s < hi)
        bar = "#" * int(60 * n / len(all_ml))
        print(f"  [{lo:6.3f}, {hi:6.3f})  {n:5d}  {bar}")
    n_mid = sum(1 for s in all_ml if 0.05 <= s < 0.95)
    print(f"\n  Mid-range (0.05 to 0.95): {n_mid}/{len(all_ml)} = {n_mid/len(all_ml)*100:.2f}%")
    print(f"  → Saturated claim: {'CONFIRMED' if n_mid/len(all_ml) < 0.05 else 'NEEDS REVIEW'}")

    print("\n" + "=" * 70)
    print("CLAIM 3: p99 latency 891ms — discrepancy with CLAUDE.md's 4ms")
    print("=" * 70)
    for label, rows in [("sequential C=1", seq), ("concurrent C=16", conc)]:
        lats = sorted([r["latency_ms"] for r in rows if r.get("status", 0) >= 200])
        if not lats:
            continue
        p50 = lats[len(lats)//2]
        p95 = lats[int(len(lats)*0.95)]
        p99 = lats[int(len(lats)*0.99)]
        print(f"\n  [{label}]  n={len(lats)}  p50={p50}ms  p95={p95}ms  p99={p99}ms  max={lats[-1]}ms")

    print("\nNote: my sim measures CLIENT-side latency through nginx → audit → Kafka")
    print("CLAUDE.md's 4ms is in-process /v1/predict only (no nginx hop, no audit, no Kafka)")
    print("These ARE NOT the same measurement.")

    print("\n" + "=" * 70)
    print("CLAIM 4: Legit ATM withdrawals — 5-6% FP rate")
    print("=" * 70)
    for label, rows in [("sequential", seq), ("concurrent", conc)]:
        atm = [r for r in rows if r["typology"] == "legit_atm_withdrawal"]
        scores = [r["fraud_probability"] for r in atm if r.get("fraud_probability") is not None]
        # FP = legit blocked. Block = score >= threshold OR rule-driven DECLINE
        blocked = 0
        for r in atm:
            src = r.get("decision_source")
            dec = r.get("decision")
            if src in ("PRE_RULE", "POST_RULE"):
                blocked += 1 if dec in ("DECLINE", "REVIEW") else 0
            else:
                blocked += 1 if (r.get("fraud_probability") or 0) >= 0.15 else 0
        print(f"  [{label}] n={len(atm)} blocked={blocked} rate={blocked/len(atm)*100:.2f}%")
        # Score distribution
        n_above = sum(1 for s in scores if s >= 0.15)
        n_zero = sum(1 for s in scores if s < 0.01)
        print(f"    score<0.01: {n_zero}    score>=0.15: {n_above}    max={max(scores):.4f}")

    print("\n" + "=" * 70)
    print("BONUS: ML-decision-only score distribution by typology (verify saturation)")
    print("=" * 70)
    by_typ = defaultdict(list)
    for r in seq:
        if r.get("decision_source") == "ML" and r.get("fraud_probability") is not None:
            by_typ[r["typology"]].append(r["fraud_probability"])
    for typ in sorted(by_typ.keys()):
        scores = sorted(by_typ[typ])
        if not scores:
            continue
        p50 = scores[len(scores)//2]
        p95 = scores[int(len(scores)*0.95)] if len(scores) > 20 else scores[-1]
        gt = "FRAUD" if typ.startswith("app_") or typ.startswith("ato_") or typ.startswith("bec_") \
            or typ.startswith("synthetic") or typ.startswith("mule") or typ.startswith("money") \
            or typ.startswith("refund_to") or typ.startswith("romance") or typ.startswith("first_party") \
            else "LEGIT"
        print(f"  {gt:5s} {typ:32s} n={len(scores):4d}  min={scores[0]:.4f}  p50={p50:.4f}  p95={p95:.4f}  max={scores[-1]:.4f}")


if __name__ == "__main__":
    main()
