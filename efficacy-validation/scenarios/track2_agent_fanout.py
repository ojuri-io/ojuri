"""Track 2 (all legitimate): agent-network fan-out. Six mobile-money agents
each serve dozens of walk-in customers in a day (cash-in disbursements and
cash-out collections). High fan-out + high velocity from a single account is
exactly what naive systems misread as a ring hub."""

import random

from scenarios import common

NAME = "track2_agent_fanout"
PREFIX = "t2agent"
SEED = 201
NOTES = "Zero fraud by construction. Every flag is a false positive."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 240)
    start = anchor_ms - DAY

    agents = [{"id": f"ev1u-{PREFIX}-{run_id}-agent{i}", "account_age_days": rng.randint(200, 1500),
               "wallet_balance": round(rng.uniform(500_000, 5_000_000), 2), "channel": "AGENT"}
              for i in range(6)]

    events = []
    seq = 0
    for agent in agents:
        agent_lat = 6.5 + rng.uniform(-0.3, 0.3)
        agent_lng = 3.35 + rng.uniform(-0.3, 0.3)
        for _ in range(50):
            customer = pool.pick()
            ts = common.business_hour_ts(rng, start)
            if rng.random() < 0.55:
                body = common.base_body(rng, agent, customer["id"],
                                        round(rng.uniform(1_000, 50_000), 2), "CASH_IN",
                                        ts, run_id, PREFIX, seq)
            else:
                body = common.base_body(rng, customer, agent["id"],
                                        round(rng.uniform(1_000, 60_000), 2), "CASH_OUT",
                                        ts, run_id, PREFIX, seq)
            body["agent_id"] = agent["id"]
            body["agent_latitude"] = round(agent_lat, 5)
            body["agent_longitude"] = round(agent_lng, 5)
            body["agent_battery_level"] = rng.randint(15, 100)
            events.append(common.event(body, fraud=False, role="agent_txn",
                                       barrier=(seq % 100 == 0)))
            seq += 1

    followon = common.baseline_stream(rng, pool, run_id, PREFIX, 120, start, DAY, seq_start=600)
    return common.sort_stream(events + followon)
