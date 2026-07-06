"""Track 3: amount-distribution shift. Identical structure to track3_indist
(same type mix, same bare fields, same 2% fraud-as-8x-amount construction) but
amounts follow the Nigerian mobile-money distribution instead of
lognormal(8,2). Isolates the effect of amount scale alone."""

import random

from scenarios import common

NAME = "track3_shift_amounts"
PREFIX = "t3amt"
SEED = 302
NOTES = "Only the amount distribution differs from track3_indist."

DAY = common.DAY


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    start = anchor_ms - DAY
    users = [f"ev1u-{PREFIX}-{run_id}-u{i:04d}" for i in range(300)]

    events = []
    for i in range(900):
        is_fraud = rng.random() < 0.02
        amt = common.ng_amount(rng)
        if is_fraud:
            amt = round(amt * 8, 2)
        body = {
            "transaction_id": f"ev1-{PREFIX}-{run_id}-{i:06d}",
            "sender_id": rng.choice(users),
            "receiver_id": rng.choice(users),
            "amount": max(amt, 0.01),
            "transaction_type": rng.choices(common.TXN_TYPES, common.PAYSIM_TYPE_WEIGHTS)[0],
            "timestamp": start + rng.randint(0, DAY - 1),
        }
        if body["receiver_id"] == body["sender_id"]:
            body["receiver_id"] = users[(users.index(body["sender_id"]) + 1) % len(users)]
        events.append(common.event(body, fraud=is_fraud,
                                   typology="amount_outlier" if is_fraud else None,
                                   role="shift_amounts"))
    return common.sort_stream(events)
