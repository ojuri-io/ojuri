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
import os
import sys
import time
from typing import Any

import aiohttp
import psycopg2


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
    payload = {
        # Reuse the existing transactionId so audit-log JOIN works.
        # /v1/predict's unique-constraint is on (tenantId, transactionId);
        # since we truncate the audit log before replay this is safe.
        "transaction_id": row["transactionId"],
        "sender_id": row["senderId"],
        "receiver_id": row["receiverId"],
        "amount": float(row["amount"]),
        "transaction_type": row["transactionType"],
        # `timestamp` in the predict DTO is unix seconds. Use wall-clock
        # at replay time so PAA sees these events at "now" — that's
        # what makes PaySim's per-sender repeats land inside PAA's
        # velocity_1h / velocity_24h windows.
        "timestamp": int(time.time()),
        "wallet_balance": float(row["walletBalance"]) if row["walletBalance"] is not None else 0,
        # Fill in reasonable defaults for the request-level fields the
        # PaySim CSV doesn't carry, so feature-builder gets non-default
        # request fields and only the PAA-sourced positions vary.
        "is_authenticated": True,
        "channel": "MOBILE",
        "currency": "USD",
        "account_age_days": 365,
        "transaction_country": "US",
        "ip_country": "US",
        "device_is_trusted": True,
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
