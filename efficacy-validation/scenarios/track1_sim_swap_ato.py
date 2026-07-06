"""Track 1: SIM-swap account takeover. Five victims with rich prior history are
taken over: untrusted device, VPN, foreign IP country, sub-10s session-to-txn,
wallet-draining transfers at three amount tiers (sub-N100k / N100k-1M / >1M).
The over-1M tier matches the seeded FATF ATO-signature DENY rule; the demo
N100k rule sits in front of both upper tiers."""

import random

from scenarios import common

NAME = "track1_sim_swap_ato"
PREFIX = "ato"
SEED = 105
NOTES = "Each victim gets ~15 txns of legitimate history before the takeover."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 60)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 250, start, 3 * DAY - HOUR)

    victims = rng.sample(pool.users, 5)
    seq = 400
    for v in victims:
        for _ in range(15):
            receiver = pool.pick()
            ts = common.business_hour_ts(rng, start + rng.randint(0, 2) * DAY)
            body = common.base_body(rng, v, receiver["id"], common.ng_amount(rng),
                                    rng.choices(common.TXN_TYPES, common.NG_TYPE_WEIGHTS)[0],
                                    ts, run_id, PREFIX, seq)
            events.append(common.event(body, fraud=False, role="victim_history"))
            seq += 1

    tiers = [("sub_100k", 45_000, 95_000), ("100k_1M", 150_000, 800_000),
             ("over_1M", 1_050_000, 2_500_000)]
    fraud = []
    t = anchor_ms - HOUR
    seq = 700
    for v in victims:
        drain_receiver = f"ev1u-{PREFIX}-{run_id}-drain-{v['id'][-5:]}"
        for tier_name, lo, hi in tiers:
            body = common.base_body(rng, v, drain_receiver, round(rng.uniform(lo, hi), 2),
                                    "TRANSFER", t, run_id, PREFIX, seq)
            body["device_is_trusted"] = False
            body["ip_is_vpn"] = True
            body["ip_country"] = "GB"
            body["session_to_txn_seconds"] = round(rng.uniform(3, 8), 1)
            body["device_type"] = "MOBILE"
            body["device_fingerprint"] = {"browser": "Chrome Mobile 125",
                                          "os": "Android 14", "screen_resolution": "1080x2340"}
            fraud.append(common.event(body, fraud=True, typology="sim_swap_ato",
                                      subpattern=tier_name, role="attacker", barrier=True))
            seq += 1
            t += rng.randint(60, 240) * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 60,
                                      anchor_ms - HOUR, HOUR, seq_start=900)
    return common.sort_stream(events + fraud + trailing)
