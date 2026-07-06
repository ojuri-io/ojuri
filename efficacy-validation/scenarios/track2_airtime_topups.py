"""Track 2 (all legitimate): airtime top-ups and bill payments. Three hundred
small PAYMENTs (N100-N2,000) from many senders to a handful of telco merchant
accounts -- rapid small payments to few merchants is the card-testing
false-positive shape. Plus utility bill PAYMENTs of N5k-N30k, which sit
squarely inside the seeded 'demo: moderate payment review' rule band."""

import random

from scenarios import common

NAME = "track2_airtime_topups"
PREFIX = "t2air"
SEED = 204
NOTES = "Zero fraud by construction."

DAY = common.DAY
HOUR = common.HOUR

MERCHANTS = ["merch-mtn-airtime", "merch-airtel-airtime", "merch-glo-airtime",
             "merch-9mobile-airtime"]
BILLERS = ["merch-ikeja-electric", "merch-dstv", "merch-lawma-waste"]


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 200)
    start = anchor_ms - DAY

    events = []
    seq = 0
    for _ in range(300):
        sender = pool.pick()
        ts = common.business_hour_ts(rng, start)
        amt = rng.choice([100, 200, 200, 500, 500, 1000, 1000, 1500, 2000])
        body = common.base_body(rng, sender, f"ev1u-{PREFIX}-{run_id}-{rng.choice(MERCHANTS)}",
                                float(amt), "PAYMENT", ts, run_id, PREFIX, seq)
        events.append(common.event(body, fraud=False, role="airtime",
                                   barrier=(seq % 120 == 0)))
        seq += 1

    for _ in range(100):
        sender = pool.pick()
        ts = common.business_hour_ts(rng, start)
        body = common.base_body(rng, sender, f"ev1u-{PREFIX}-{run_id}-{rng.choice(BILLERS)}",
                                round(rng.uniform(5_000, 30_000), 2), "PAYMENT",
                                ts, run_id, PREFIX, seq)
        events.append(common.event(body, fraud=False, role="bill_payment"))
        seq += 1

    background = common.baseline_stream(rng, pool, run_id, PREFIX, 100, start, DAY, seq_start=600)
    return common.sort_stream(events + background)
