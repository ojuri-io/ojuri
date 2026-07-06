"""Scenario runner: pushes a generated stream through the running stack,
collects verdicts, joins ground truth + audit rows, computes metrics.

Usage:
    python3 harness/runner.py --scenario scenarios/track1_mule_network.py \
        [--run-id 20260706T120000] [--rps 20] [--results results]

Exit code 0 = harness completed (regardless of what Ojuri decided).
Non-zero = harness failure (non-200 responses, unreachable stack, ...).

Barriers: an event marked barrier=True waits until PAA's /stats
processedCount has caught up with everything sent so far, then sleeps
past the 10s Redis batch-flush interval, so the next prediction sees
PAA state that includes all prior events. This models an attacker
pacing a burst over minutes rather than milliseconds; without it the
Redis write lag (batch size 100 / 10s flush) would mean compressed
bursts are scored on stale features.
"""

import argparse
import datetime
import gzip
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness import client, metrics, observe

FLUSH_WAIT_S = 11.0

SNAPSHOT_FIELDS = ["hour_of_day", "day_of_week", "is_weekend", "is_off_hours",
                   "velocity_1h", "velocity_24h", "unique_receivers_24h",
                   "graph_pagerank", "graph_community_id", "graph_in_degree",
                   "graph_out_degree", "pair_is_first_send", "pair_prior_send_count",
                   "amount_zscore_vs_sender", "amount", "device_is_trusted",
                   "is_authenticated", "ip_is_vpn", "session_to_txn_seconds",
                   "channel_code", "currency_code", "has_kyc_id"]


def load_scenario(path):
    spec = importlib.util.spec_from_file_location("scenario", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git_sha():
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip()
    except Exception:
        return None


def barrier(sent_count, paa_base):
    ok = client.wait_for_paa(paa_base + sent_count)
    time.sleep(FLUSH_WAIT_S)
    return ok


def run(args):
    mod = load_scenario(args.scenario)
    anchor_ms = int(time.time() * 1000)
    run_id = args.run_id or datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    stream = mod.build(run_id=run_id, anchor_ms=anchor_ms)
    name = mod.NAME

    out_dir = os.path.join(args.results, name)
    os.makedirs(out_dir, exist_ok=True)
    started_iso = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")

    paa_base = client.paa_stats().get("processedCount")
    if paa_base is None:
        print("WARN: PAA /stats unreachable; barriers degrade to fixed sleeps", file=sys.stderr)
        paa_base = -1

    records, observations = [], []
    sent = 0
    min_interval = 1.0 / args.rps
    last_send = 0.0
    barrier_misses = 0

    for ev in stream:
        if ev.get("sleep_before_s"):
            time.sleep(ev["sleep_before_s"])
        if ev.get("observe"):
            obs = {
                "wall_time": time.time(), "events_sent": sent,
                "label": ev["observe"].get("label"),
                "redis": observe.redis_features(ev["observe"]["users"]),
                "postgres": observe.pg_community(ev["observe"]["users"]),
                "paa_stats": client.paa_stats(),
            }
            observations.append(obs)
            continue
        if ev.get("barrier"):
            if paa_base >= 0:
                if not barrier(sent, paa_base):
                    barrier_misses += 1
            else:
                time.sleep(FLUSH_WAIT_S + 5)

        body = dict(ev["body"])
        if ev.get("live_ts"):
            body["timestamp"] = int(time.time() * 1000)

        wait = min_interval - (time.time() - last_send)
        if wait > 0:
            time.sleep(wait)
        last_send = time.time()

        status, resp = client.predict(body)
        sent += 1
        records.append({"seq": sent, "body": body, "truth": ev["truth"],
                        "http_status": status, "response": resp,
                        "sent_at_wall": round(last_send, 3)})
        if sent % 200 == 0:
            print(f"  {name}: {sent}/{len(stream)} sent", file=sys.stderr)

    if paa_base >= 0:
        barrier(sent, paa_base)

    token = client.admin_token()
    search = urllib.parse.quote(f"ev1-{mod.PREFIX}-{run_id}")
    audit_rows = client.fetch_audit_rows(token, search, started_iso)
    by_txn = {r["transactionId"]: r for r in audit_rows}
    # The audit list endpoint omits featuresSnapshot; the public detail
    # endpoint returns it, one transaction at a time.
    for i, rec in enumerate(records):
        row = by_txn.get(rec["body"]["transaction_id"])
        if row:
            snap = client.fetch_decision_snapshot(token, rec["body"]["transaction_id"])
            rec["audit"] = {
                "featuresDefault": row.get("featuresDefault"),
                "championScore": row.get("championScore"),
                "mlDecision": row.get("mlDecision"),
                "decisionSource": row.get("decisionSource"),
                "ruleName": row.get("ruleName"),
                "featuresSnapshot": {k: snap.get(k) for k in SNAPSHOT_FIELDS if k in snap},
            }
        if (i + 1) % 300 == 0:
            print(f"  {name}: snapshot join {i + 1}/{len(records)}", file=sys.stderr)

    audit_joined = sum(1 for r in records if r.get("audit"))
    result_metrics = metrics.compute(records)
    meta = {
        "scenario": name, "scenario_file": args.scenario, "seed": mod.SEED,
        "run_id": run_id, "anchor_ms": anchor_ms, "git_sha": git_sha(),
        "started": started_iso,
        "finished": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "events_sent": sent, "rps_limit": args.rps,
        "audit_rows_joined": audit_joined, "barrier_misses": barrier_misses,
        "notes": getattr(mod, "NOTES", None),
    }

    with gzip.open(os.path.join(out_dir, "raw.jsonl.gz"), "wt") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")
    if observations:
        with open(os.path.join(out_dir, "observations.jsonl"), "w") as f:
            for obs in observations:
                f.write(json.dumps(obs) + "\n")
    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(result_metrics, f, indent=2)
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps({"scenario": name, "metrics": result_metrics, "meta": meta}, indent=2))
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--scenario", required=True)
    p.add_argument("--run-id", default=None)
    p.add_argument("--rps", type=float, default=client.DEFAULT_RPS)
    p.add_argument("--results", default=os.path.join(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))), "results"))
    args = p.parse_args()
    try:
        sys.exit(run(args))
    except client.HarnessError as e:
        print(f"HARNESS FAILURE: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
