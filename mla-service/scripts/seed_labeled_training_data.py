"""
Seed labeled training data into Postgres `transactions` so
`train_initial_model.py` can pull it instead of falling back to its
random-noise synthetic generator.

Fraud rule (the model needs to *learn* this — we do not encode it as
a hand-coded rule anywhere RDA can see):

    fraud_label = 1 iff ANY of:
        - amount > 25_000  AND account_age_days < 60
        - ip_is_vpn = true AND amount > 5_000
        - ip_country != transaction_country (geo mismatch) AND amount > 1_000
        - is_authenticated = false AND amount > 500
        - account_age_days < 7 AND amount > 1_000

Plus random noise (5%) flipping labels so the model has to generalise
rather than memorise.

Run from the repo root:
    cd mla-service && source venv/bin/activate
    python scripts/seed_labeled_training_data.py --count 20000
"""

import argparse
import os
import random
import sys
import uuid
from datetime import datetime, timezone, timedelta

import psycopg2

LOW_RISK_COUNTRIES = ["US", "CA", "GB", "DE", "FR", "AU", "NL", "JP", "SE", "NG"]
HIGH_RISK_COUNTRIES = ["RU", "KP", "IR", "VE", "BY"]
TXN_TYPES = ["CASH_IN", "CASH_OUT", "PAYMENT", "TRANSFER", "DEBIT"]
CHANNELS = ["MOBILE", "WEB", "POS", "AGENT"]


def gen_row(idx: int, seed_rng: random.Random) -> dict:
    """
    Generate one transaction with a deterministic fraud label per the rule.

    The class mix is biased toward including realistic-looking *fraud
    patterns* so the trainer sees:
      - high-amount new-account drains
      - VPN/unauth card-testing (small amounts)
      - cross-border geo mismatch
      - structured smurfing (just-below-threshold amounts)
      - recurring international transfers (romance-scam-shaped)

    Each pattern is encoded as its own profile branch so the trainer
    learns a *family* of fraud rules, not a single threshold.
    """
    profile = seed_rng.random()

    if profile < 0.70:
        # Legit-shaped: small amounts, mature account, authenticated, trusted device
        amount = seed_rng.lognormvariate(3.5, 1.0)  # ~$30–$300 typical
        account_age_days = seed_rng.randint(180, 3000)
        is_authenticated = True
        ip_is_vpn = False
        device_is_trusted = seed_rng.random() < 0.85
        country = seed_rng.choice(LOW_RISK_COUNTRIES)
        ip_country = country
        session_seconds = seed_rng.randint(20, 600)
        is_recurring = seed_rng.random() < 0.15
        txn_type = seed_rng.choice(TXN_TYPES)
    elif profile < 0.78:
        # Card-testing: tiny amount, unauth, VPN, fast session, weird IP country
        amount = seed_rng.uniform(0.5, 8.0)
        account_age_days = seed_rng.randint(60, 1500)
        is_authenticated = False
        ip_is_vpn = True
        device_is_trusted = False
        country = seed_rng.choice(LOW_RISK_COUNTRIES)
        ip_country = seed_rng.choice(HIGH_RISK_COUNTRIES + LOW_RISK_COUNTRIES)
        session_seconds = seed_rng.randint(1, 4)
        is_recurring = False
        txn_type = "PAYMENT"
    elif profile < 0.84:
        # Smurfing: structured TRANSFERs just below $10k
        amount = seed_rng.uniform(9_300, 9_950)
        account_age_days = seed_rng.randint(30, 400)
        is_authenticated = True
        ip_is_vpn = seed_rng.random() < 0.3
        device_is_trusted = False
        country = seed_rng.choice(LOW_RISK_COUNTRIES)
        ip_country = country
        session_seconds = seed_rng.randint(10, 60)
        is_recurring = False
        txn_type = "TRANSFER"
    elif profile < 0.90:
        # Romance scam: recurring mid-size international transfer from
        # mature account to high-risk destination
        amount = seed_rng.uniform(800, 5_000)
        account_age_days = seed_rng.randint(800, 3500)
        is_authenticated = True
        ip_is_vpn = False
        device_is_trusted = True
        country = "US"
        ip_country = "US"
        session_seconds = seed_rng.randint(30, 200)
        is_recurring = True
        txn_type = "TRANSFER"
        destination_country = seed_rng.choice(HIGH_RISK_COUNTRIES + ["NG", "PH", "GH"])
        # Override destination for this branch; rest of return uses
        # `country` for both transaction_country and destination_country
        # unless we replace it explicitly below.
        out = _base_row(
            idx, seed_rng, amount, account_age_days, is_authenticated,
            ip_is_vpn, device_is_trusted, country, ip_country,
            session_seconds, txn_type,
        )
        out["destinationCountry"] = destination_country
        out["isRecurring"] = True
        out["fraudLabel"] = True if seed_rng.random() > 0.05 else False
        return out
    else:
        # Generic fraud-shaped (~10% prior): wide amount range, mix of red flags
        amount = seed_rng.choice(
            [
                seed_rng.uniform(30_000, 500_000),
                seed_rng.uniform(1_000, 10_000),
                seed_rng.uniform(2_000, 50_000),
            ]
        )
        account_age_days = seed_rng.choice([seed_rng.randint(0, 30), seed_rng.randint(30, 200)])
        is_authenticated = seed_rng.random() < 0.6
        ip_is_vpn = seed_rng.random() < 0.5
        device_is_trusted = False
        country = seed_rng.choice(LOW_RISK_COUNTRIES)
        ip_country = (
            seed_rng.choice(HIGH_RISK_COUNTRIES) if seed_rng.random() < 0.4 else country
        )
        session_seconds = seed_rng.choice([seed_rng.randint(1, 5), seed_rng.randint(10, 60)])
        is_recurring = False
        txn_type = seed_rng.choice(TXN_TYPES)

    # Learnable fraud rule for non-romance branches
    fraud = (
        (amount > 25_000 and account_age_days < 60)
        or (ip_is_vpn and amount > 5_000)
        or (ip_country != country and amount > 1_000)
        or (not is_authenticated and amount > 500)
        or (account_age_days < 7 and amount > 1_000)
        # Card-testing signature: tiny amount + unauth + VPN
        or (not is_authenticated and ip_is_vpn and session_seconds < 5)
        # Smurfing signature: structured amount in [9_000, 10_000)
        or (txn_type == "TRANSFER" and 9_000 < amount < 10_000 and account_age_days < 500)
    )

    # 5% label noise so the model has to generalise
    if seed_rng.random() < 0.05:
        fraud = not fraud

    out = _base_row(
        idx, seed_rng, amount, account_age_days, is_authenticated,
        ip_is_vpn, device_is_trusted, country, ip_country,
        session_seconds, txn_type,
    )
    out["isRecurring"] = is_recurring
    out["fraudLabel"] = fraud
    return out


def _base_row(
    idx, rng, amount, account_age_days, is_authenticated,
    ip_is_vpn, device_is_trusted, country, ip_country,
    session_seconds, txn_type,
) -> dict:
    ts_ms = int(
        (datetime.now(tz=timezone.utc) - timedelta(seconds=rng.randint(0, 30 * 86_400))).timestamp() * 1000
    )
    return {
        "transactionId": f"train-{idx:07d}-{uuid.uuid4().hex[:8]}",
        "senderId": f"train_sender_{idx % 5000}",
        "receiverId": f"train_receiver_{idx % 8000}",
        "amount": round(amount, 2),
        "transactionType": txn_type,
        "timestamp": ts_ms,
        "fraudLabel": False,
        "decisionSource": "ML",
        "accountAgeDays": account_age_days,
        "isAuthenticated": is_authenticated,
        "channel": rng.choice(CHANNELS),
        "currency": "USD",
        "transactionCountry": country,
        "destinationCountry": country,
        "ipCountry": ip_country,
        "ipIsVpn": ip_is_vpn,
        "deviceIsTrusted": device_is_trusted,
        "sessionToTxnSeconds": session_seconds,
        "isRecurring": False,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=int, default=20000)
    p.add_argument("--host", default=os.getenv("POSTGRES_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.getenv("POSTGRES_PORT", "5433")))
    p.add_argument("--db", default=os.getenv("POSTGRES_DB", "fraud_db"))
    p.add_argument("--user", default=os.getenv("POSTGRES_USER", "postgres"))
    p.add_argument("--password", default=os.getenv("POSTGRES_PASSWORD", "postgres"))
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    rng = random.Random(args.seed)
    rows = [gen_row(i, rng) for i in range(args.count)]
    fraud_count = sum(1 for r in rows if r["fraudLabel"])
    print(f"Generated {len(rows)} rows · fraud_rate={fraud_count/len(rows):.2%}")

    conn = psycopg2.connect(
        host=args.host, port=args.port, dbname=args.db, user=args.user, password=args.password
    )
    conn.autocommit = False
    cur = conn.cursor()

    insert_sql = """
        INSERT INTO transactions (
            "transactionId", "senderId", "receiverId", amount, "transactionType",
            "timestamp", "fraudLabel", "decisionSource",
            "accountAgeDays", "isAuthenticated", "channel", "currency",
            "transactionCountry", "destinationCountry", "ipCountry",
            "ipIsVpn", "deviceIsTrusted", "sessionToTxnSeconds", "isRecurring"
        ) VALUES (
            %(transactionId)s, %(senderId)s, %(receiverId)s, %(amount)s, %(transactionType)s,
            %(timestamp)s, %(fraudLabel)s, %(decisionSource)s,
            %(accountAgeDays)s, %(isAuthenticated)s, %(channel)s, %(currency)s,
            %(transactionCountry)s, %(destinationCountry)s, %(ipCountry)s,
            %(ipIsVpn)s, %(deviceIsTrusted)s, %(sessionToTxnSeconds)s, %(isRecurring)s
        )
        ON CONFLICT ("transactionId") DO NOTHING
    """

    batch = 1000
    inserted = 0
    for i in range(0, len(rows), batch):
        cur.executemany(insert_sql, rows[i : i + batch])
        inserted += cur.rowcount if cur.rowcount > 0 else batch
        if (i // batch) % 5 == 0:
            print(f"  inserted {min(i + batch, len(rows))}/{len(rows)}…")

    conn.commit()
    cur.close()
    conn.close()
    print(f"✅ Done. Rows in transactions: see SELECT count(*) FROM transactions WHERE \"fraudLabel\" IS NOT NULL;")


if __name__ == "__main__":
    main()
