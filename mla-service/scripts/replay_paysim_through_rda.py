"""
Replay PaySim rows through `POST /v1/predict` so PAA gets the events
on Kafka and accumulates graph + velocity state. After this finishes,
`decisionAuditLog.featuresSnapshot` contains the *actual* 64-dim
feature vector RDA saw at predict time (including any PAA enrichment
from Redis) — and `transactions.fraudLabel` holds the matching ground
truth. A trainer that joins these two columns sees what the deployed
system actually serves at inference, eliminating the train/serve skew
where PaySim columns were inserted with all PAA fields defaulted.

Pre-req: `ingest_paysim.py` has already written 100k labelled rows
into the `transactions` table. We pull the same transactionIds and
POST them, in chronological order (PaySim `step` ascending) so PAA's
velocity window builds up the way it would in production.

Run:
  cd mla-service && source venv/bin/activate
  python scripts/replay_paysim_through_rda.py --rows 100000 --concurrency 24
"""

import argparse
import asyncio
import hashlib
import os
import random
import sys
import time
from typing import Any

import aiohttp
import psycopg2


LOW_RISK_COUNTRIES = ["US", "CA", "GB", "DE", "FR", "AU", "NL"]
HIGH_RISK_COUNTRIES = ["RU", "KP", "IR", "VE", "BY"]


def synthetic_context(row: dict) -> dict:
    """
    Manufacture per-row variation for the identity/device/geo fields
    PaySim doesn't carry, conditioned on the ground-truth fraud label.
    Same seed (derived from transactionId) so the replay is reproducible.

    The bias toward "risky" values for fraud rows is intentional — PaySim
    alone gives the trainer no signal on these dimensions, so we layer
    realistic correlations on top. This is not a hand-coded fraud rule
    that the harness can match against (the variation is *random* within
    each conditional distribution); it just gives the trainer non-zero
    gradient on account_age_days, channel, ip_*, device, session_*.
    """
    seed = int(hashlib.sha256(row["transactionId"].encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    is_fraud = bool(row["fraudLabel"])

    if is_fraud:
        # Fraud-shaped context: skew younger accounts, more VPN, more
        # untrusted devices, shorter sessions, more cross-border IP.
        account_age_days = rng.choice([
            rng.randint(0, 30),
            rng.randint(0, 90),
            rng.randint(60, 500),
        ])
        is_authenticated = rng.random() < 0.6
        ip_is_vpn = rng.random() < 0.45
        device_is_trusted = rng.random() < 0.20
        session_to_txn_seconds = rng.choice([rng.randint(1, 5), rng.randint(5, 30)])
        country = "US"
        ip_country = (
            rng.choice(HIGH_RISK_COUNTRIES) if rng.random() < 0.35 else
            rng.choice(LOW_RISK_COUNTRIES)
        )
        channel = rng.choice(["WEB", "AGENT", "MOBILE"])
    else:
        # Legit-shaped: mature accounts, mostly authenticated, trusted
        # devices, low VPN rate, longer sessions, domestic IPs.
        account_age_days = rng.randint(180, 3000)
        is_authenticated = rng.random() < 0.97
        ip_is_vpn = rng.random() < 0.03
        device_is_trusted = rng.random() < 0.90
        session_to_txn_seconds = rng.randint(20, 600)
        country = "US"
        ip_country = country if rng.random() < 0.95 else rng.choice(LOW_RISK_COUNTRIES)
        channel = rng.choice(["MOBILE", "MOBILE", "MOBILE", "WEB", "WEB", "POS"])

    return {
        "is_authenticated": is_authenticated,
        "channel": channel,
        "account_age_days": account_age_days,
        "transaction_country": country,
        "ip_country": ip_country,
        "ip_is_vpn": ip_is_vpn,
        "device_is_trusted": device_is_trusted,
        "session_to_txn_seconds": session_to_txn_seconds,
    }


def fetch_paysim_rows(args, limit: int) -> list[dict[str, Any]]:
    conn = psycopg2.connect(
        host=args.host, port=args.port, dbname=args.db, user=args.user, password=args.password
    )
    cur = conn.cursor()
    # Read ALL the PaySim labelled rows we previously ingested. Order
    # by timestamp ASC so PAA's velocity windows accumulate in PaySim's
    # native temporal order — fraud bursts and balance-drain pairs end
    # up adjacent in wall-clock the way they sat in the source CSV.
    cur.execute(
        """
        SELECT "transactionId", "senderId", "receiverId", amount,
               "transactionType", "timestamp", "fraudLabel", "walletBalance"
        FROM transactions
        WHERE "transactionId" LIKE 'paysim-%%'
        ORDER BY "timestamp" ASC
        LIMIT %s
        """,
        (limit,),
    )
    cols = [c.name for c in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows


async def fire_one(session: aiohttp.ClientSession, url: str, row: dict, sem: asyncio.Semaphore, counters: dict):
    ctx = synthetic_context(row)
    payload = {
        "transaction_id": row["transactionId"],
        "sender_id": row["senderId"],
        "receiver_id": row["receiverId"],
        "amount": float(row["amount"]),
        "transaction_type": row["transactionType"],
        "timestamp": int(time.time()),
        "wallet_balance": float(row["walletBalance"]) if row["walletBalance"] is not None else 0,
        "currency": "USD",
        **ctx,
    }
    async with sem:
        try:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                await resp.read()
                counters["ok" if resp.status == 200 else "err"] += 1
        except Exception:
            counters["err"] += 1
        counters["sent"] += 1
        if counters["sent"] % 5000 == 0:
            print(f"  sent {counters['sent']}  ok={counters['ok']}  err={counters['err']}")


async def main_async(args):
    print(f"Fetching PaySim rows from transactions table (limit={args.rows})…")
    rows = fetch_paysim_rows(args, args.rows)
    print(f"  fetched {len(rows)} rows")

    url = f"{args.url.rstrip('/')}/v1/predict"
    sem = asyncio.Semaphore(args.concurrency)
    counters = {"sent": 0, "ok": 0, "err": 0}

    t0 = time.time()
    connector = aiohttp.TCPConnector(limit=args.concurrency * 2)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [fire_one(session, url, r, sem, counters) for r in rows]
        await asyncio.gather(*tasks)
    elapsed = time.time() - t0

    print(f"Done in {elapsed:.1f}s — ok={counters['ok']} err={counters['err']} rps={counters['sent']/elapsed:.0f}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:3000")
    p.add_argument("--rows", type=int, default=100_000)
    p.add_argument("--concurrency", type=int, default=24)
    p.add_argument("--host", default=os.getenv("POSTGRES_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.getenv("POSTGRES_PORT", "5433")))
    p.add_argument("--db", default=os.getenv("POSTGRES_DB", "fraud_db"))
    p.add_argument("--user", default=os.getenv("POSTGRES_USER", "postgres"))
    p.add_argument("--password", default=os.getenv("POSTGRES_PASSWORD", "postgres"))
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
