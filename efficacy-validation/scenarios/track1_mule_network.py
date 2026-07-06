"""Track 1: mule network. Twelve established victims fan in to four fresh mule
accounts; mules forward ~90% onward to a single aggregator; the aggregator
cashes out in sub-N100k chunks. All fraud amounts stay under the N100k demo
DENY rule so the graph/velocity path is what gets tested."""

import random

from scenarios import common

NAME = "track1_mule_network"
PREFIX = "mule"
SEED = 102
NOTES = ("Fan-in -> forward -> cash-out over ~4 simulated hours. Barriers between "
         "layers and every third transaction inside a layer.")

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 90)
    start = anchor_ms - 3 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 350, start, 3 * DAY - 4 * HOUR)

    victims = rng.sample(pool.users, 12)
    mules = [{"id": f"ev1u-{PREFIX}-{run_id}-mule{i}", "account_age_days": rng.randint(3, 30),
              "wallet_balance": 5_000.0, "channel": "MOBILE"} for i in range(4)]
    agg = {"id": f"ev1u-{PREFIX}-{run_id}-agg0", "account_age_days": rng.randint(3, 30),
           "wallet_balance": 5_000.0, "channel": "MOBILE"}

    fraud = []
    t = anchor_ms - 4 * HOUR
    seq = 500
    k = 0
    mule_totals = {m["id"]: 0.0 for m in mules}
    for v in victims:
        for _ in range(rng.choice([1, 1, 2])):
            m = mules[k % 4]
            amt = round(rng.uniform(30_000, 95_000), 2)
            mule_totals[m["id"]] += amt
            body = common.base_body(rng, v, m["id"], amt, "TRANSFER", t, run_id, PREFIX, seq)
            fraud.append(common.event(body, fraud=True, typology="mule_network",
                                      subpattern="victim_to_mule", role="victim",
                                      barrier=(k % 3 == 0)))
            seq += 1
            k += 1
            t += rng.randint(3, 12) * 60 * 1000

    for m in mules:
        remaining = mule_totals[m["id"]] * 0.9
        first = True
        while remaining >= 1:
            amt = max(round(min(remaining, rng.uniform(80_000, 95_000)), 2), 1.0)
            remaining -= amt
            body = common.base_body(rng, m, agg["id"], amt, "TRANSFER", t, run_id, PREFIX, seq)
            fraud.append(common.event(body, fraud=True, typology="mule_network",
                                      subpattern="mule_to_aggregator", role="mule",
                                      barrier=first))
            first = False
            seq += 1
            t += rng.randint(2, 8) * 60 * 1000

    agg_total = sum(mule_totals.values()) * 0.9 * 0.95
    first = True
    while agg_total >= 1:
        amt = max(round(min(agg_total, rng.uniform(90_000, 99_000)), 2), 1.0)
        agg_total -= amt
        body = common.base_body(rng, agg, f"ev1u-{PREFIX}-{run_id}-cashpoint", amt,
                                "CASH_OUT", t, run_id, PREFIX, seq)
        fraud.append(common.event(body, fraud=True, typology="mule_network",
                                  subpattern="aggregator_cash_out", role="aggregator",
                                  barrier=first or seq % 3 == 0))
        first = False
        seq += 1
        t += rng.randint(2, 6) * 60 * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 80,
                                      anchor_ms - 4 * HOUR, 4 * HOUR, seq_start=900)
    return common.sort_stream(events + fraud + trailing)
