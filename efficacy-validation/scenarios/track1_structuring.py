"""Track 1: structuring. Two subpatterns:
  fatf_band -- eight CASH_OUTs of N4.5M-N4.99M across two simulated days,
               exactly the band the seeded FATF structuring rule targets
               (note: the N100k demo DENY rule sits in front of it)
  sub_100k  -- twelve CASH_OUTs of N90k-N99k in one day, classic structuring
               under the demo rule's own threshold, which only velocity/ML
               could catch"""

import random

from scenarios import common

NAME = "track1_structuring"
PREFIX = "struct"
SEED = 104
NOTES = "Structuring users have prior legitimate history."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 80)
    start = anchor_ms - 4 * DAY

    events = common.baseline_stream(rng, pool, run_id, PREFIX, 300, start, 2 * DAY)

    s1, s2 = rng.sample(pool.users, 2)
    fraud = []
    seq = 500
    t = anchor_ms - 2 * DAY
    for i in range(8):
        body = common.base_body(rng, s1, f"ev1u-{PREFIX}-{run_id}-cashpoint-a",
                                round(rng.uniform(4_500_000, 4_990_000), 2), "CASH_OUT",
                                t, run_id, PREFIX, seq)
        fraud.append(common.event(body, fraud=True, typology="structuring",
                                  subpattern="fatf_band", role="structurer",
                                  barrier=(i % 3 == 0)))
        seq += 1
        t += rng.randint(3, 8) * HOUR

    t = anchor_ms - DAY
    for i in range(12):
        body = common.base_body(rng, s2, f"ev1u-{PREFIX}-{run_id}-cashpoint-b",
                                round(rng.uniform(90_000, 99_000), 2), "CASH_OUT",
                                t, run_id, PREFIX, seq)
        fraud.append(common.event(body, fraud=True, typology="structuring",
                                  subpattern="sub_100k", role="structurer",
                                  barrier=(i % 3 == 0)))
        seq += 1
        t += rng.randint(60, 150) * 60 * 1000

    trailing = common.baseline_stream(rng, pool, run_id, PREFIX, 100,
                                      anchor_ms - 2 * DAY, 2 * DAY, seq_start=800)
    return common.sort_stream(events + fraud + trailing)
