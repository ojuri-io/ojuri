"""Track 4: community-assignment stability. A 5-ring is fully formed quickly
(two cycles, 30s apart), then held static while background traffic keeps the
graph recompute ticking (every 100 events / every 5 min). Twelve observation
ticks at 75s intervals measure how often Louvain reassigns the ring members'
community IDs when the ring itself is NOT changing -- the churn side of the
known community-ID non-determinism."""

import random

from scenarios import common

NAME = "track4_community_stability"
PREFIX = "t4stab"
SEED = 403
NOTES = "~17 min wall time. Ring static after formation; only background flows."

TICKS = 12


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    uprefix = f"ev1u-{PREFIX}-{run_id}"
    ring = [{"id": f"{uprefix}-ring{i}", "account_age_days": rng.randint(5, 40),
             "wallet_balance": 100_000.0, "channel": "MOBILE"} for i in range(5)]
    ring_ids = [m["id"] for m in ring]
    bg = [{"id": f"{uprefix}-bg{i:03d}", "account_age_days": rng.randint(60, 1500),
           "wallet_balance": round(rng.uniform(10_000, 400_000), 2), "channel": "MOBILE"}
          for i in range(40)]

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

    for _ in range(20):
        events.append(bg_txn(sleep=0.4))
    for cycle in range(2):
        for i in range(5):
            body = common.base_body(rng, ring[i], ring[(i + 1) % 5]["id"],
                                    round(rng.uniform(15_000, 45_000), 2), "TRANSFER",
                                    0, run_id, PREFIX, seq)
            seq += 1
            events.append(common.event(body, fraud=True, typology="ring_warmup",
                                       subpattern=f"formation_cycle{cycle + 1}",
                                       role="ring_member", sleep_before_s=3.0, live_ts=True))
        events.append(observe(f"formation_cycle{cycle + 1}", sleep=30.0))

    for tick in range(TICKS):
        for _ in range(10):
            events.append(bg_txn(sleep=1.2))
        events.append(observe(f"tick{tick + 1:02d}", sleep=60.0))

    return events
