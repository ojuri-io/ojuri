"""Track 3: in-distribution proxy stream.

The deployed model's exact training set is not recoverable from the repo (see
report, 'model provenance'). The closest documented distributions are the MLA
synthetic generator (mla-service/src/training/data_loader.py: amounts ~
lognormal(mu=8, sigma=2), fraud propensity rising with amount) and PaySim
replays (PaySim type mix, minimal context fields). This stream follows those:
lognormal(8,2) amounts, PaySim type weights, required fields only, uniform
hours. 2% fraud by construction, expressed as an 8x amount multiplier --
mirroring the synthetic labeler where only amount drives the label."""

import random

from scenarios import common

NAME = "track3_indist"
PREFIX = "t3ind"
SEED = 301
NOTES = "In-distribution is a PROXY -- see model-provenance limitation."

DAY = common.DAY


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    start = anchor_ms - DAY
    users = [f"ev1u-{PREFIX}-{run_id}-u{i:04d}" for i in range(300)]

    events = []
    for i in range(900):
        is_fraud = rng.random() < 0.02
        amt = common.paysim_amount(rng)
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
                                   role="indist"))
    return common.sort_stream(events)
