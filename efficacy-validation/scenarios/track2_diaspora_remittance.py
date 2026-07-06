"""Track 2 (all legitimate): diaspora remittances. Forty inbound remittances
(N80k-N900k) initiated from abroad (GB/US/CA IP country, occasional VPN --
common for expats), receivers later cash out or transfer on. Unusual geography
plus large amounts is the classic remittance false-positive shape."""

import random

from scenarios import common

NAME = "track2_diaspora_remittance"
PREFIX = "t2remit"
SEED = 203
NOTES = "Zero fraud by construction. 15% of remitters use a VPN."

DAY = common.DAY
HOUR = common.HOUR


def build(run_id: str, anchor_ms: int):
    rng = random.Random(SEED)
    pool = common.UserPool(rng, f"ev1u-{PREFIX}-{run_id}", 120)
    start = anchor_ms - DAY

    events = []
    seq = 0
    recipients = []
    for i in range(40):
        remitter = {"id": f"ev1u-{PREFIX}-{run_id}-abroad{i:02d}",
                    "account_age_days": rng.randint(100, 2000),
                    "wallet_balance": round(rng.uniform(200_000, 3_000_000), 2),
                    "channel": "WEB"}
        recipient = pool.pick()
        recipients.append(recipient)
        ts = start + rng.randint(0, DAY - 4 * HOUR)
        body = common.base_body(rng, remitter, recipient["id"],
                                round(rng.lognormvariate(12.2, 0.6), 2), "TRANSFER",
                                ts, run_id, PREFIX, seq)
        body["ip_country"] = rng.choice(["GB", "US", "CA", "GB", "US"])
        body["ip_is_vpn"] = rng.random() < 0.15
        body["is_inflow"] = True
        body["destination_country"] = "NG"
        events.append(common.event(body, fraud=False, role="remittance",
                                   barrier=(seq % 15 == 0)))
        seq += 1

    for recipient in recipients:
        for _ in range(rng.randint(1, 3)):
            ts = common.business_hour_ts(rng, start) + rng.randint(2, 8) * HOUR
            ts = min(ts, anchor_ms - 1)
            if rng.random() < 0.6:
                body = common.base_body(rng, recipient, f"ev1u-{PREFIX}-{run_id}-cashpoint",
                                        round(rng.uniform(20_000, 150_000), 2), "CASH_OUT",
                                        ts, run_id, PREFIX, seq)
            else:
                other = pool.pick()
                body = common.base_body(rng, recipient, other["id"],
                                        round(rng.uniform(5_000, 80_000), 2), "TRANSFER",
                                        ts, run_id, PREFIX, seq)
            events.append(common.event(body, fraud=False, role="recipient_spend"))
            seq += 1

    background = common.baseline_stream(rng, pool, run_id, PREFIX, 150, start, DAY, seq_start=600)
    return common.sort_stream(events + background)
