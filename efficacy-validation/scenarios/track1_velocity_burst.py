"""Track 1: velocity anomaly. One established user (20 txns of history over
three days) suddenly fires 30 transfers in five simulated minutes to 25
distinct receivers, amounts N5k-N45k -- under every seeded rule threshold, so
only the velocity features / ML path can catch it."""

import random

from scenarios import common

NAME = "track1_velocity_burst"
PREFIX = "velburst"
SEED = 107
NOTES = "Barrier every 3rd burst txn; velocity windows are event-time in PAA."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 70)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 300, start, 3 * DAY - HOUR)

    burster = pool.users[0]
    seq = 400
    for _ in range(20):
        receiver = pool.pick()
        ts = common.business_hour_ts(rng, start + rng.randint(0, 2) * DAY)
        body = common.base_body(rng, burster, receiver["id"], common.ng_amount(rng),
                                "TRANSFER", ts, run_id, PREFIX, seq)
        events.append(common.event(body, fraud=False, role="burster_history"))
        seq += 1

    fraud = []
    t = anchor_ms - 30 * 60 * 1000
    seq = 600
    for i in range(30):
        receiver = f"ev1u-{PREFIX}-{run_id}-out{i % 25:02d}"
        body = common.base_body(rng, burster, receiver,
                                round(rng.uniform(5_000, 45_000), 2), "TRANSFER",
                                t, run_id, PREFIX, seq)
        body["session_to_txn_seconds"] = round(rng.uniform(2, 10), 1)
        fraud.append(common.event(body, fraud=True, typology="velocity_anomaly",
                                  role="burster", barrier=(i % 3 == 0)))
        seq += 1
        t += rng.randint(6, 14) * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 60,
                                      anchor_ms - 25 * 60 * 1000, 25 * 60 * 1000, seq_start=800)
    return common.sort_stream(events + fraud + trailing)
