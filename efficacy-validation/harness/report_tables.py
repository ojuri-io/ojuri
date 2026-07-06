"""Emit the markdown tables for report.md from results/*/metrics.json.

Usage: python3 harness/report_tables.py [results_dir]"""

import json
import os
import sys


def load(results_dir):
    out = {}
    for name in sorted(os.listdir(results_dir)):
        mp = os.path.join(results_dir, name, "metrics.json")
        meta_p = os.path.join(results_dir, name, "meta.json")
        if os.path.exists(mp):
            out[name] = {"metrics": json.load(open(mp))}
            if os.path.exists(meta_p):
                out[name]["meta"] = json.load(open(meta_p))
    return out


def fmt(v):
    if v is None:
        return "--"
    if isinstance(v, float):
        return f"{v:.4f}".rstrip("0").rstrip(".")
    return str(v)


def verdict_cell(d):
    return " / ".join(f"{d.get(k, 0)}" for k in ("ACCEPT", "REVIEW", "DECLINE"))


def track1(results):
    print("| Scenario | Seed | Fraud txns | Recall (flagged) | Recall (declined) | "
          "Precision (flagged) | FP rate (legit) | Fraud verdicts A/R/D | TTFD (fraud txn #) |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, r in results.items():
        if not name.startswith("track1"):
            continue
        m = r["metrics"]
        ttfd = m.get("time_to_first_detection") or {}
        print(f"| {name} | {r['meta']['seed']} | {m['totals']['fraud']} | "
              f"{fmt(m['recall_flagged'])} | {fmt(m['recall_declined'])} | "
              f"{fmt(m['precision_flagged'])} | {fmt(m['false_positive_rate'])} | "
              f"{verdict_cell(m['verdicts_fraud'])} | {fmt(ttfd.get('fraud_txn_index'))} |")


def attribution(results, prefix):
    print("| Scenario | Attribution of flags | Count |")
    print("|---|---|---|")
    for name, r in results.items():
        if not name.startswith(prefix):
            continue
        m = r["metrics"]
        key = "attribution_fraud_flagged" if prefix == "track1" else "attribution_legit_flagged"
        for attr, count in sorted(m.get(key, {}).items(), key=lambda kv: -kv[1]):
            print(f"| {name} | {attr} | {count} |")


def track2(results):
    print("| Scenario | Seed | Legit txns | FP rate | Legit verdicts A/R/D |")
    print("|---|---|---|---|---|")
    for name, r in results.items():
        if not name.startswith("track2"):
            continue
        m = r["metrics"]
        print(f"| {name} | {r['meta']['seed']} | {m['totals']['legit']} | "
              f"{fmt(m['false_positive_rate'])} | {verdict_cell(m['verdicts_legit'])} |")


def track3(results):
    print("| Stream | Seed | Verdicts legit A/R/D | FP rate | ML score p50 (legit, ML-only) | "
          "ML score mean (legit, ML-only) | featuresDefault rate |")
    print("|---|---|---|---|---|---|---|")
    for name, r in results.items():
        if not name.startswith("track3"):
            continue
        m = r["metrics"]
        ml = m.get("score_stats_legit_ml_only") or {}
        print(f"| {name} | {r['meta']['seed']} | {verdict_cell(m['verdicts_legit'])} | "
              f"{fmt(m['false_positive_rate'])} | {fmt(ml.get('p50'))} | {fmt(ml.get('mean'))} | "
              f"{fmt(m.get('features_default_rate'))} |")


def subpatterns(results):
    print("| Scenario | Subpattern | Fraud txns | Recall (flagged) | Verdicts |")
    print("|---|---|---|---|---|")
    for name, r in results.items():
        subs = r["metrics"].get("by_subpattern")
        if not subs:
            continue
        for s, v in subs.items():
            print(f"| {name} | {s} | {v['fraud_txns']} | {fmt(v['recall_flagged'])} | "
                  f"{json.dumps(v['verdicts'])} |")


if __name__ == "__main__":
    results = load(sys.argv[1] if len(sys.argv) > 1 else
                   os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "results"))
    for section, fn in [("TRACK 1", track1), ("TRACK 1 SUBPATTERNS", subpatterns),
                        ("TRACK 1 ATTRIBUTION", lambda r: attribution(r, "track1")),
                        ("TRACK 2", track2),
                        ("TRACK 2 ATTRIBUTION", lambda r: attribution(r, "track2")),
                        ("TRACK 3", track3)]:
        print(f"\n### {section}\n")
        fn(results)
