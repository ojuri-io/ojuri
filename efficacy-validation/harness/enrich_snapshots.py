"""Backfill audit featuresSnapshot into existing raw.jsonl.gz files.

The admin audit LIST endpoint omits featuresSnapshot; the public detail
endpoint GET /v1/decisions/:transactionId returns it. Fetching 7.5k details
one-by-one is slow, so this reads the same rows in bulk from the
decisionAuditLog table and verifies equivalence against the public detail
endpoint on a random sample per scenario. Read-only.

Usage: python3 harness/enrich_snapshots.py results/<scenario> [...]"""

import gzip
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness import client, metrics

KEEP = ["hour_of_day", "day_of_week", "is_weekend", "is_off_hours",
        "velocity_1h", "velocity_24h", "unique_receivers_24h",
        "graph_pagerank", "graph_community_id", "graph_in_degree",
        "graph_out_degree", "pair_is_first_send", "pair_prior_send_count",
        "amount_zscore_vs_sender", "amount", "device_is_trusted",
        "is_authenticated", "ip_is_vpn", "session_to_txn_seconds",
        "channel_code", "currency_code", "has_kyc_id"]


def bulk_rows(prefix):
    sql = (
        'SELECT json_build_object('
        "'transactionId', \"transactionId\", 'featuresDefault', \"featuresDefault\", "
        "'championScore', \"championScore\", 'mlDecision', \"mlDecision\", "
        "'decisionSource', \"decisionSource\", 'ruleName', \"ruleName\", "
        "'featuresSnapshot', \"featuresSnapshot\") "
        f'FROM "decisionAuditLog" WHERE "transactionId" LIKE \'{prefix}%\';'
    )
    out = subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql",
                          "-U", "postgres", "-d", "fraud_db", "-tA", "-c", sql],
                         capture_output=True, text=True, timeout=120).stdout
    rows = {}
    for line in out.splitlines():
        line = line.strip()
        if line:
            row = json.loads(line)
            rows[row["transactionId"]] = row
    return rows


def verify_sample(token, rows, sample_n=10):
    ids = random.sample(sorted(rows), min(sample_n, len(rows)))
    for txn_id in ids:
        status, payload = client._request("GET", f"/v1/decisions/{txn_id}", token=token)
        if status != 200:
            raise RuntimeError(f"detail fetch failed for {txn_id}: {status}")
        api_row = payload.get("data", payload)
        api_snap = api_row.get("featuresSnapshot") or {}
        pg_snap = rows[txn_id].get("featuresSnapshot") or {}
        for k in KEEP:
            if k in api_snap and api_snap.get(k) != pg_snap.get(k):
                raise RuntimeError(f"snapshot mismatch on {txn_id}.{k}: "
                                   f"api={api_snap.get(k)} pg={pg_snap.get(k)}")
    return len(ids)


def enrich(out_dir, token):
    raw_path = os.path.join(out_dir, "raw.jsonl.gz")
    with gzip.open(raw_path, "rt") as f:
        records = [json.loads(line) for line in f]
    prefix = records[0]["body"]["transaction_id"].rsplit("-", 1)[0]
    rows = bulk_rows(prefix)
    verified = verify_sample(token, rows)
    joined = 0
    for rec in records:
        row = rows.get(rec["body"]["transaction_id"])
        if row:
            snap = row.get("featuresSnapshot") or {}
            rec["audit"] = {
                "featuresDefault": row.get("featuresDefault"),
                "championScore": row.get("championScore"),
                "mlDecision": row.get("mlDecision"),
                "decisionSource": row.get("decisionSource"),
                "ruleName": row.get("ruleName"),
                "featuresSnapshot": {k: snap.get(k) for k in KEEP if k in snap},
            }
            joined += 1
    with gzip.open(raw_path, "wt") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")
    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(metrics.compute(records), f, indent=2)
    print(f"{out_dir}: joined={joined}/{len(records)} api_verified={verified}")


if __name__ == "__main__":
    token = client.admin_token()
    for out_dir in sys.argv[1:]:
        enrich(out_dir, token)
