"""Track 4: ring warm-up, N=8, denser wiring. Each member sends to the next
member AND to two skip-hops per round (out-degree 3), four rounds, 45s apart.
Measures whether a denser ring surfaces a shared community faster than the
sparse 5-cycle in track4_ring5."""

import random

from scenarios import common

NAME = "track4_ring8_dense"
PREFIX = "t4ring8"
SEED = 402
NOTES = "~11 min wall time."

ROUNDS = 4
STABILIZE_TICKS = 5


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    uprefix = f"ev1u-{PREFIX}-{run_id}"
    ring = [{"id": f"{uprefix}-ring{i}", "account_age_days": rng.randint(5, 40),
             "wallet_balance": 150_000.0, "channel": "MOBILE"} for i in range(8)]
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

    for _ in range(25):
        events.append(bg_txn(sleep=0.4))
    events.append(observe("before_ring"))

    for rnd in range(ROUNDS):
        for i in range(8):
            for hop in (1, 2, 3):
                receiver = ring[(i + hop) % 8]
                body = common.base_body(rng, ring[i], receiver["id"],
                                        round(rng.uniform(10_000, 40_000), 2), "TRANSFER",
                                        0, run_id, PREFIX, seq)
                seq += 1
                events.append(common.event(body, fraud=True, typology="ring_warmup",
                                           subpattern=f"round{rnd + 1}", role="ring_member",
                                           sleep_before_s=1.5, live_ts=True))
        for _ in range(4):
            events.append(bg_txn(sleep=1.5))
        events.append(observe(f"after_round{rnd + 1}", sleep=45.0))

    for tick in range(STABILIZE_TICKS):
        for _ in range(8):
            events.append(bg_txn(sleep=1.5))
        events.append(observe(f"stabilize_tick{tick + 1}", sleep=45.0))

    return events
