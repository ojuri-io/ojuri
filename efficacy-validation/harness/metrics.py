"""Metric computation over joined (ground truth, verdict) records.

FLAGGED means decision in {REVIEW, DECLINE}. Attribution buckets:
  PRE_RULE:<name> / POST_RULE:<name>  -- rules engine
  ML:default-features                 -- ONNX score computed on the Redis-miss
                                         fallback snapshot (no PAA state)
  ML:paa-features                     -- ONNX score with live PAA features;
                                         top reason-code category appended
"""

from collections import Counter

FLAGGED = {"REVIEW", "DECLINE"}

PAA_FEATURE_PREFIXES = ("VELOCITY", "PAGERANK", "CLUSTERING", "TIME_SINCE_LAST",
                        "AVG_AMOUNT", "STD_AMOUNT")


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return round(sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f), 4)


def attribution(rec) -> str:
    resp = rec["response"]
    src = resp.get("decision_source")
    if src in ("PRE_RULE", "POST_RULE"):
        rule = resp.get("rule") or {}
        return f"{src}:{rule.get('name', '?')}"
    audit = rec.get("audit") or {}
    if audit.get("featuresDefault"):
        return "ML:default-features"
    codes = resp.get("reason_codes") or []
    top = codes[0]["code"] if codes else "?"
    origin = "paa" if top.startswith(PAA_FEATURE_PREFIXES) else "request"
    return f"ML:paa-features(top={top}:{origin})"


def score_stats(vals):
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return {}
    return {
        "n": len(vals),
        "mean": round(sum(vals) / len(vals), 4),
        "p05": percentile(vals, 0.05), "p25": percentile(vals, 0.25),
        "p50": percentile(vals, 0.50), "p75": percentile(vals, 0.75),
        "p95": percentile(vals, 0.95), "min": round(vals[0], 4), "max": round(vals[-1], 4),
    }


def compute(records) -> dict:
    fraud = [r for r in records if r["truth"]["fraud"]]
    legit = [r for r in records if not r["truth"]["fraud"]]

    def decisions(rs):
        return Counter(r["response"]["decision"] for r in rs)

    fraud_flagged = [r for r in fraud if r["response"]["decision"] in FLAGGED]
    legit_flagged = [r for r in legit if r["response"]["decision"] in FLAGGED]
    all_flagged = fraud_flagged + legit_flagged

    ttfd = None
    for idx, r in enumerate(fraud):
        if r["response"]["decision"] in FLAGGED:
            first_ts = fraud[0]["body"]["timestamp"]
            ttfd = {"fraud_txn_index": idx + 1, "of_fraud_txns": len(fraud),
                    "event_time_offset_s": round((r["body"]["timestamp"] - first_ts) / 1000, 1)}
            break

    out = {
        "totals": {"transactions": len(records), "fraud": len(fraud), "legit": len(legit)},
        "verdicts_fraud": dict(decisions(fraud)),
        "verdicts_legit": dict(decisions(legit)),
        "recall_flagged": round(len(fraud_flagged) / len(fraud), 4) if fraud else None,
        "recall_declined": round(sum(1 for r in fraud if r["response"]["decision"] == "DECLINE")
                                 / len(fraud), 4) if fraud else None,
        "precision_flagged": round(len(fraud_flagged) / len(all_flagged), 4) if all_flagged else None,
        "false_positive_rate": round(len(legit_flagged) / len(legit), 4) if legit else None,
        "time_to_first_detection": ttfd,
        "attribution_fraud_flagged": dict(Counter(attribution(r) for r in fraud_flagged)),
        "attribution_legit_flagged": dict(Counter(attribution(r) for r in legit_flagged)),
        "score_stats_fraud": score_stats([r["response"].get("fraud_probability") for r in fraud]),
        "score_stats_legit": score_stats([r["response"].get("fraud_probability") for r in legit]),
        "score_stats_fraud_ml_only": score_stats(
            [r["response"].get("fraud_probability") for r in fraud
             if r["response"].get("decision_source") == "ML"]),
        "score_stats_legit_ml_only": score_stats(
            [r["response"].get("fraud_probability") for r in legit
             if r["response"].get("decision_source") == "ML"]),
        "features_default_rate": _features_default_rate(records),
    }

    subs = sorted({r["truth"].get("subpattern") for r in fraud if r["truth"].get("subpattern")})
    if subs:
        out["by_subpattern"] = {}
        for s in subs:
            sf = [r for r in fraud if r["truth"].get("subpattern") == s]
            flagged = sum(1 for r in sf if r["response"]["decision"] in FLAGGED)
            out["by_subpattern"][s] = {
                "fraud_txns": len(sf),
                "recall_flagged": round(flagged / len(sf), 4),
                "verdicts": dict(Counter(r["response"]["decision"] for r in sf)),
            }
    return out


def _features_default_rate(records):
    with_audit = [r for r in records if r.get("audit")]
    if not with_audit:
        return None
    return round(sum(1 for r in with_audit if r["audit"].get("featuresDefault")) / len(with_audit), 4)
