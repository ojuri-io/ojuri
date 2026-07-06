"""Track 1: shared-device cluster. Eight ostensibly unrelated fresh senders all
transact from one device fingerprint, sending to an overlapping receiver set.

Code-reading note (verify empirically): no feature in
models/feature-catalog.v1.json consumes device_fingerprint, so the shipped
stack has no pathway that can see fingerprint sharing. This scenario measures
whether anything else (velocity, graph overlap) fires instead."""

import random

from scenarios import common

NAME = "track1_shared_device"
PREFIX = "shdev"
SEED = 106
NOTES = "device_fingerprint identical across all eight senders."

DAY = common.DAY
HOUR = common.HOUR

FINGERPRINT = {"browser": "Chrome Mobile 124", "os": "Android 13",
               "screen_resolution": "1080x2400"}


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 70)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 300, start, 3 * DAY - 2 * HOUR)

    cluster = [{"id": f"ev1u-{PREFIX}-{run_id}-c{i}", "account_age_days": rng.randint(1, 20),
                "wallet_balance": round(rng.uniform(20_000, 120_000), 2), "channel": "MOBILE"}
               for i in range(8)]
    receivers = [f"ev1u-{PREFIX}-{run_id}-sink{i}" for i in range(3)]

    fraud = []
    t = anchor_ms - 2 * HOUR
    seq = 500
    n = 0
    for sender in cluster:
        for _ in range(rng.randint(4, 6)):
            body = common.base_body(rng, sender, rng.choice(receivers),
                                    round(rng.uniform(8_000, 60_000), 2), "TRANSFER",
                                    t, run_id, PREFIX, seq)
            body["device_fingerprint"] = dict(FINGERPRINT)
            body["device_type"] = "MOBILE"
            body["device_is_trusted"] = False
            fraud.append(common.event(body, fraud=True, typology="shared_device_cluster",
                                      role="cluster_member", barrier=(n % 4 == 0)))
            seq += 1
            n += 1
            t += rng.randint(1, 6) * 60 * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 60,
                                      anchor_ms - 2 * HOUR, 2 * HOUR, seq_start=800)
    return common.sort_stream(events + fraud + trailing)
