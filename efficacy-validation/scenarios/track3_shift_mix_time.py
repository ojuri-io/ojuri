"""Track 3: full adopter shift. Nigerian amounts AND Nigerian type mix AND
business-hours timing AND full mobile-money context fields (channel, currency,
nationality, device, auth) -- the shape a real NG adopter's day-1 traffic
would take. Same 2% fraud-as-8x-amount construction as the other two Track 3
streams. Deltas against track3_indist measure the whole day-1 gap; deltas
against track3_shift_amounts isolate the non-amount portion."""

import random

from scenarios import common

NAME = "track3_shift_mix_time"
PREFIX = "t3mix"
SEED = 303
NOTES = "Full NG context fields; business-hours event times."

DAY = common.DAY


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    start = anchor_ms - DAY
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 300)

    events = []
    for i in range(900):
        is_fraud = rng.random() < 0.02
        amt = common.ng_amount(rng)
        if is_fraud:
            amt = round(amt * 8, 2)
        sender, receiver = pool.pick_two()
        ts = common.business_hour_ts(rng, start + rng.randint(0, 0))
        body = common.base_body(rng, sender, receiver["id"], max(amt, 0.01),
                                rng.choices(common.TXN_TYPES, common.NG_TYPE_WEIGHTS)[0],
                                ts, run_id, PREFIX, i)
        events.append(common.event(body, fraud=is_fraud,
                                   typology="amount_outlier" if is_fraud else None,
                                   role="shift_mix_time"))
    return common.sort_stream(events)
