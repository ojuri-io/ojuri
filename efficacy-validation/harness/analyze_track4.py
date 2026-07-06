"""Summarize a Track 4 observations.jsonl into a warm-up/stability table.

For each observation tick: elapsed wall time, events sent so far, each ring
member's community ID (Postgres graphMetadata, full integer) and pagerank
(Redis), whether all members share one community, and whether any member's
community ID changed since the previous tick (churn).

Usage: python3 harness/analyze_track4.py results/<scenario>"""

import json
import os
import sys


def main():
    out_dir = sys.argv[1]
    with open(os.path.join(out_dir, "observations.jsonl")) as f:
        obs = [json.loads(line) for line in f]

    t0 = obs[0]["wall_time"]
    prev_pg = None
    rows = []
    churn_total = 0
    first_shared = None
    for o in obs:
        users = sorted(o["postgres"].keys() | o["redis"].keys())
        pg_comm = {u: o["postgres"].get(u, {}).get("communityId") for u in users}
        redis_comm = {u: (o["redis"].get(u) or {}).get("graph_community_id") for u in users}
        present = [c for c in pg_comm.values() if c not in (None, "")]
        expected = len(o["redis"])
        shared = (len(present) == expected and expected > 0 and len(set(present)) == 1)
        churned = []
        if prev_pg is not None:
            churned = [u for u in users
                       if pg_comm.get(u) not in (None, "") and prev_pg.get(u) not in (None, "")
                       and pg_comm[u] != prev_pg[u]]
            churn_total += len(churned)
        if shared and first_shared is None:
            first_shared = o["label"]
        rows.append({
            "label": o["label"],
            "elapsed_s": round(o["wall_time"] - t0, 1),
            "events_sent": o["events_sent"],
            "pg_community_ids": pg_comm,
            "redis_community_ids": redis_comm,
            "all_share_one_community": shared,
            "distinct_communities": len(set(present)) if present else None,
            "members_with_metadata": len(present),
            "churned_members": churned,
            "pagerank": {u: (o["redis"].get(u) or {}).get("graph_pagerank") for u in users},
        })
        prev_pg = pg_comm

    summary = {
        "ticks": len(rows),
        "first_tick_all_shared": first_shared,
        "total_churn_events": churn_total,
        "rows": rows,
    }
    with open(os.path.join(out_dir, "warmup_curve.json"), "w") as f:
        json.dump(summary, f, indent=2)
    for r in rows:
        print(f'{r["label"]:22s} t+{r["elapsed_s"]:7.1f}s sent={r["events_sent"]:4d} '
              f'meta={r["members_with_metadata"]} distinct={r["distinct_communities"]} '
              f'shared={r["all_share_one_community"]} churn={len(r["churned_members"])}')
    print(f'first_all_shared={first_shared} total_churn={churn_total}')


if __name__ == "__main__":
    main()
