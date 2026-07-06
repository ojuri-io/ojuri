"""Track 1: mobile-money ring. Six fresh accounts cycle funds A0->A1->...->A5->A0
for three full cycles with escalating amounts, plus intra-ring layering hops,
inside otherwise-legitimate traffic. Ring amounts stay under N100k so the
demo amount rule cannot trivially catch them."""

import random

from scenarios import common

NAME = "track1_mobile_money_ring"
PREFIX = "ring"
SEED = 101
NOTES = ("Ring amounts N18k-N75k (below the N100k demo DENY rule). Barriers on "
         "every hop so each prediction sees PAA state including all prior hops.")

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 80)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 350, start, 3 * DAY - 2 * HOUR)

    ring = [{"id": f"ev1u-{PREFIX}-{run_id}-ring{i}", "account_age_days": rng.randint(5, 40),
             "wallet_balance": round(rng.uniform(50_000, 200_000), 2), "channel": "MOBILE",
             "home_hour_peak": 14} for i in range(6)]

    fraud = []
    t = anchor_ms - 2 * HOUR
    amount = rng.uniform(18_000, 25_000)
    seq = 500
    for cycle in range(3):
        for i in range(6):
            sender, receiver = ring[i], ring[(i + 1) % 6]
            body = common.base_body(rng, sender, receiver["id"], round(amount, 2),
                                    "TRANSFER", t, run_id, PREFIX, seq)
            fraud.append(common.event(body, fraud=True, typology="mobile_money_ring",
                                      subpattern=f"cycle{cycle + 1}", role="ring_member",
                                      barrier=True))
            seq += 1
            t += rng.randint(2, 8) * 60 * 1000
            amount *= rng.uniform(1.05, 1.25)
    for _ in range(6):
        a, b = rng.sample(ring, 2)
        body = common.base_body(rng, a, b["id"], round(rng.uniform(20_000, 75_000), 2),
                                "TRANSFER", t, run_id, PREFIX, seq)
        fraud.append(common.event(body, fraud=True, typology="mobile_money_ring",
                                  subpattern="layering", role="ring_member", barrier=True))
        seq += 1
        t += rng.randint(1, 5) * 60 * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 80,
                                      anchor_ms - 2 * HOUR, 2 * HOUR, seq_start=800)
    return common.sort_stream(events + fraud + trailing)
