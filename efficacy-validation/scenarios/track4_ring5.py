"""Track 4: ring warm-up curve, N=5. Five fresh accounts form ring edges
progressively (six full cycles, one hop every ~4s, 60s between rounds) inside
a background trickle. Runs in real time (live_ts): PAA's graph recompute
triggers on wall-clock interval (GRAPH_UPDATE_INTERVAL=5min) and on every
100th event, so background volume drives recompute ticks.

Observation events snapshot each ring member's graph_community_id / pagerank
from Redis (the exact hash RDA reads) and from the graphMetadata Postgres
table, without writing anything. Public claim under test: velocity signals
immediate; small dense rings surface at 5-60 minutes."""

import random

from scenarios import common

NAME = "track4_ring5"
PREFIX = "t4ring5"
SEED = 401
NOTES = "~16 min wall time. Louvain in PAA is unseeded; churn is measured, not fixed."

ROUNDS = 6
STABILIZE_TICKS = 8


def _bg_user(rng, prefix, i):
    return {"id": f"{prefix}-bg{i:03d}", "account_age_days": rng.randint(60, 1500),
            "wallet_balance": round(rng.uniform(10_000, 400_000), 2), "channel": "MOBILE"}


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    uprefix = f"ev1u-{PREFIX}-{run_id}"
    ring = [{"id": f"{uprefix}-ring{i}", "account_age_days": rng.randint(5, 40),
             "wallet_balance": 100_000.0, "channel": "MOBILE"} for i in range(5)]
    ring_ids = [m["id"] for m in ring]
    bg = [_bg_user(rng, uprefix, i) for i in range(40)]

    events = []
    seq = 0

    def bg_txn(sleep=0.0):
        nonlocal seq
        a, b = rng.sample(bg, 2)
        body = common.base_body(rng, a, b["id"], common.ng_amount(rng),
                                rng.choices(common.TXN_TYPES, common.NG_TYPE_WEIGHTS)[0],
                                0, run_id, PREFIX, seq)
        seq += 1
        return common.event(body, fraud=False, role="background",
                            sleep_before_s=sleep, live_ts=True)

    def observe(label, sleep=0.0):
        return {"observe": {"users": ring_ids, "label": label}, "sleep_before_s": sleep,
                "truth": None}

    for _ in range(30):
        events.append(bg_txn(sleep=0.4))
    events.append(observe("before_ring"))

    for rnd in range(ROUNDS):
        for i in range(5):
            sender, receiver = ring[i], ring[(i + 1) % 5]
            body = common.base_body(rng, sender, receiver["id"],
                                    round(rng.uniform(15_000, 45_000), 2), "TRANSFER",
                                    0, run_id, PREFIX, seq)
            seq += 1
            events.append(common.event(body, fraud=True, typology="ring_warmup",
                                       subpattern=f"round{rnd + 1}", role="ring_member",
                                       sleep_before_s=4.0, live_ts=True))
        for _ in range(4):
            events.append(bg_txn(sleep=2.0))
        events.append(observe(f"after_round{rnd + 1}", sleep=45.0))

    for tick in range(STABILIZE_TICKS):
        for _ in range(8):
            events.append(bg_txn(sleep=1.5))
        events.append(observe(f"stabilize_tick{tick + 1}", sleep=45.0))

    return events
