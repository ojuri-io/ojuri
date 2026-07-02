"""Scorecard for fraud-sim ground-truth output.

  python3 scripts/fraud-sim-score.py /tmp/sim-p1.jsonl [more.jsonl ...]

Flagged = DECLINE or REVIEW (both reach an analyst / block).
"""

import json
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    return rows


def pct(n, d):
    return f"{100 * n / d:5.1f}%" if d else "    —"


def score(rows, title):
    fraud = [r for r in rows if r["fraud"]]
    legit = [r for r in rows if not r["fraud"]]
    flagged = lambda r: r["decision"] in ("DECLINE", "REVIEW")
    declined = lambda r: r["decision"] == "DECLINE"

    print(f"\n{'=' * 74}\n{title}\n{'=' * 74}")
    print(f"total={len(rows)}  fraud={len(fraud)} ({pct(len(fraud), len(rows)).strip()})  legit={len(legit)}")

    tp_f = sum(1 for r in fraud if flagged(r))
    tp_d = sum(1 for r in fraud if declined(r))
    fp_f = sum(1 for r in legit if flagged(r))
    fp_d = sum(1 for r in legit if declined(r))
    all_flagged = tp_f + fp_f

    print(f"\nfraud recall  (DECLINE only):        {pct(tp_d, len(fraud))}  ({tp_d}/{len(fraud)})")
    print(f"fraud recall  (DECLINE or REVIEW):   {pct(tp_f, len(fraud))}  ({tp_f}/{len(fraud)})")
    print(f"legit FPR     (DECLINE only):        {pct(fp_d, len(legit))}  ({fp_d}/{len(legit)})")
    print(f"legit FPR     (DECLINE or REVIEW):   {pct(fp_f, len(legit))}  ({fp_f}/{len(legit)})")
    print(f"flag precision (fraud / all flags):  {pct(tp_f, all_flagged)}  ({tp_f}/{all_flagged})")

    by_typ = defaultdict(list)
    for r in fraud:
        by_typ[r["typology"]].append(r)
    print(f"\n{'typology':<20} {'n':>6} {'decline':>9} {'review':>9} {'caught':>9} {'by rule':>9} {'by ML':>9}")
    for typ in sorted(by_typ):
        rs = by_typ[typ]
        d = sum(1 for r in rs if declined(r))
        rv = sum(1 for r in rs if r["decision"] == "REVIEW")
        rule = sum(1 for r in rs if flagged(r) and r["source"] in ("PRE_RULE", "POST_RULE"))
        ml = sum(1 for r in rs if flagged(r) and r["source"] == "ML")
        print(f"{typ:<20} {len(rs):>6} {pct(d, len(rs)):>9} {pct(rv, len(rs)):>9} {pct(d + rv, len(rs)):>9} {rule:>9} {ml:>9}")

    by_persona = defaultdict(list)
    for r in legit:
        by_persona[r["persona"]].append(r)
    print(f"\n{'legit persona':<20} {'n':>7} {'flagged':>9}")
    for p in sorted(by_persona):
        rs = by_persona[p]
        f = sum(1 for r in rs if flagged(r))
        print(f"{p:<20} {len(rs):>7} {pct(f, len(rs)):>9}")

    models = defaultdict(int)
    for r in rows:
        models[r.get("model")] += 1
    print(f"\nmodel versions seen: {dict(models)}")


if __name__ == "__main__":
    rows = load(sys.argv[1:])
    score(rows, f"scorecard: {' + '.join(sys.argv[1:])}")
