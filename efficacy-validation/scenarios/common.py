"""Shared primitives for deterministic Nigerian mobile-money traffic generation.

All randomness flows through a random.Random(seed) instance owned by the
scenario, so a given (seed, anchor_ms, run_id) triple always yields the same
stream content. run_id appears only inside identifiers (transaction_id,
sender_id) so re-runs do not collide with the stack's 24h idempotency
reservation; it never influences amounts, timing, or structure.

Field shapes follow src/v1/modules/rda/dtos/predict-request.dto.ts.
timestamp is Unix MILLISECONDS per the DTO contract (min 0, max 9999999999999).
"""

import random

HOUR = 3600 * 1000
DAY = 24 * HOUR

TXN_TYPES = ["TRANSFER", "CASH_IN", "CASH_OUT", "PAYMENT", "DEBIT"]
NG_TYPE_WEIGHTS = [0.45, 0.15, 0.20, 0.15, 0.05]
PAYSIM_TYPE_WEIGHTS = [0.08, 0.22, 0.35, 0.34, 0.01]

CHANNELS = ["MOBILE", "USSD", "AGENT", "WEB"]
NG_CHANNEL_WEIGHTS = [0.55, 0.25, 0.15, 0.05]

DEVICE_TYPES = {"MOBILE": "MOBILE", "USSD": "USSD", "AGENT": "AGENT_TERMINAL", "WEB": "WEB"}


def ng_amount(rng: random.Random) -> float:
    """Heavy tail at N100-N5,000, moderate N10k-N100k band, thin tail to millions."""
    band = rng.random()
    if band < 0.70:
        amt = rng.lognormvariate(7.3, 0.9)
        return round(min(max(amt, 100), 9500), 2)
    if band < 0.95:
        return round(rng.uniform(10_000, 99_000), 2)
    return round(rng.lognormvariate(12.2, 0.8), 2)


def paysim_amount(rng: random.Random) -> float:
    """Matches mla-service/src/training/data_loader.py synthetic generator:
    np.random.lognormal(8, 2)."""
    return round(max(rng.lognormvariate(8.0, 2.0), 0.01), 2)


class UserPool:
    def __init__(self, rng: random.Random, prefix: str, n: int):
        self.rng = rng
        self.users = []
        for i in range(n):
            self.users.append({
                "id": f"{prefix}-u{i:04d}",
                "account_age_days": rng.randint(30, 2000),
                "wallet_balance": round(rng.uniform(1_000, 900_000), 2),
                "home_hour_peak": rng.choice([9, 11, 13, 16, 19]),
                "channel": rng.choices(CHANNELS, NG_CHANNEL_WEIGHTS)[0],
            })

    def pick(self):
        return self.rng.choice(self.users)

    def pick_two(self):
        a = self.pick()
        b = self.pick()
        while b["id"] == a["id"]:
            b = self.pick()
        return a, b


def business_hour_ts(rng: random.Random, day_start_ms: int) -> int:
    """Bursty within 08:00-20:00 UTC, quiet overnight."""
    if rng.random() < 0.9:
        hour = min(19, max(8, int(rng.gauss(13, 3))))
    else:
        hour = rng.randint(0, 23)
    return day_start_ms + hour * HOUR + rng.randint(0, HOUR - 1)


def base_body(rng: random.Random, sender, receiver_id: str, amount: float,
              txn_type: str, ts_ms: int, run_id: str, scenario: str, seq: int) -> dict:
    channel = sender["channel"]
    return {
        "transaction_id": f"ev1-{scenario}-{run_id}-{seq:06d}",
        "sender_id": sender["id"],
        "receiver_id": receiver_id,
        "amount": amount,
        "transaction_type": txn_type,
        "timestamp": ts_ms,
        "channel": channel,
        "currency": "NGN",
        "customer_nationality": "NG",
        "transaction_country": "NG",
        "customer_type": "INDIVIDUAL",
        "account_age_days": sender["account_age_days"],
        "wallet_balance": sender["wallet_balance"],
        "is_authenticated": True,
        "device_is_trusted": True,
        "ip_is_vpn": False,
        "device_type": DEVICE_TYPES[channel],
        "session_to_txn_seconds": round(rng.uniform(20, 300), 1),
    }


def event(body: dict, fraud: bool, typology=None, subpattern=None, role=None,
          barrier=False, sleep_before_s=0.0, live_ts=False) -> dict:
    return {
        "body": body,
        "truth": {"fraud": fraud, "typology": typology, "subpattern": subpattern, "role": role},
        "barrier": barrier,
        "sleep_before_s": sleep_before_s,
        "live_ts": live_ts,
    }


def baseline_stream(rng: random.Random, pool: UserPool, run_id: str, scenario: str,
                    n: int, start_ms: int, span_ms: int, seq_start: int = 0):
    """Legitimate background traffic across the given event-time span."""
    events = []
    n_days = max(1, span_ms // DAY)
    for i in range(n):
        sender, receiver = pool.pick_two()
        day = rng.randint(0, n_days - 1)
        ts = business_hour_ts(rng, start_ms + day * DAY)
        ts = min(ts, start_ms + span_ms - 1)
        txn_type = rng.choices(TXN_TYPES, NG_TYPE_WEIGHTS)[0]
        body = base_body(rng, sender, receiver["id"], ng_amount(rng), txn_type,
                         ts, run_id, scenario, seq_start + i)
        events.append(event(body, fraud=False, role="baseline"))
    return events


def sort_stream(events):
    events.sort(key=lambda e: e["body"]["timestamp"])
    for i, e in enumerate(events):
        e["body"]["transaction_id"] = re_seq(e["body"]["transaction_id"], i)
    return events


def re_seq(txn_id: str, i: int) -> str:
    head = txn_id.rsplit("-", 1)[0]
    return f"{head}-{i:06d}"
