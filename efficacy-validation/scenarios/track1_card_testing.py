"""Track 1: card testing. One fresh attacker account fires 40 tiny PAYMENTs
(N100-N450, below the N500 demo review-rule floor) at 40 distinct merchants
within ten simulated minutes, then attempts three large purchases. Tests the
velocity/unique-receivers path rather than amount rules."""

import random

from scenarios import common

NAME = "track1_card_testing"
PREFIX = "cardtest"
SEED = 103
NOTES = "Barrier every 5th probe so velocity state accumulates mid-burst."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 70)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 300, start, 3 * DAY - HOUR)

    attacker = {"id": f"ev1u-{PREFIX}-{run_id}-attacker", "account_age_days": 2,
                "wallet_balance": 150_000.0, "channel": "WEB"}

    fraud = []
    t = anchor_ms - HOUR
    seq = 500
    for i in range(40):
        body = common.base_body(rng, attacker, f"ev1u-{PREFIX}-{run_id}-merch{i:03d}",
                                round(rng.uniform(100, 450), 2), "PAYMENT", t, run_id, PREFIX, seq)
        body["device_is_trusted"] = False
        body["session_to_txn_seconds"] = round(rng.uniform(1, 5), 1)
        fraud.append(common.event(body, fraud=True, typology="card_testing",
                                  subpattern="probe", role="attacker", barrier=(i % 5 == 0)))
        seq += 1
        t += rng.randint(5, 20) * 1000
    for i in range(3):
        body = common.base_body(rng, attacker, f"ev1u-{PREFIX}-{run_id}-merch-big{i}",
                                round(rng.uniform(40_000, 80_000), 2), "PAYMENT",
                                t, run_id, PREFIX, seq)
        body["device_is_trusted"] = False
        body["session_to_txn_seconds"] = round(rng.uniform(1, 5), 1)
        fraud.append(common.event(body, fraud=True, typology="card_testing",
                                  subpattern="monetize", role="attacker", barrier=True))
        seq += 1
        t += rng.randint(30, 90) * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 60,
                                      anchor_ms - HOUR, HOUR, seq_start=800)
    return common.sort_stream(events + fraud + trailing)
