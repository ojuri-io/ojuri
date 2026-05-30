"""
Ingest real PaySim labels into the RDA `transactions` table so
`train_initial_model.py` pulls them through the *same* feature
extraction RDA uses at inference time.

This sidesteps the column-ordering mismatch that made
`train_with_datasets.py --paysim-only` produce a model that
declined 400/400 legit at inference (see report §6e): the trainer's
PaySim pipeline padded to 434 dims using its own ordering, RDA's
feature-builder produces 64 dims in catalogue order, and the model
landed on the wrong positions. Inserting PaySim rows into the
transactions table with the same column names RDA uses guarantees
the two pipelines agree.

Mapping (PaySim → RDA transactions schema):
  step                 -> timestamp (each step = 1h from epoch 2024-01-01)
  type                 -> transactionType
  amount               -> amount
  nameOrig             -> senderId
  oldbalanceOrg        -> walletBalance
  nameDest             -> receiverId
  isFraud              -> fraudLabel
  (PaySim doesn't carry account_age_days, ip_*, device_*, channel —
   those stay NULL and the feature builder fills catalogue defaults)

Run:
  cd mla-service && source venv/bin/activate
  python scripts/ingest_paysim.py --rows 100000
"""

import argparse
import csv
import os
import random
import sys
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

import psycopg2

PAYSIM_PATH = Path(__file__).resolve().parent.parent / "data" / "paysim" / "PS_20174392719_1491204439457_log.csv"
EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rows", type=int, default=100_000, help="max rows to ingest")
    p.add_argument(
        "--fraud-multiplier",
        type=float,
        default=10.0,
        help="oversample fraud by this factor before drawing the sample, "
             "so a 100k sample has enough positives to train on. The natural "
             "PaySim fraud rate is 0.13% — at 100k rows that's only 130 "
             "positives, below SMOTE's minimum-class floor. Set to 1.0 to "
             "preserve the true distribution.",
    )
    p.add_argument("--host", default=os.getenv("POSTGRES_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.getenv("POSTGRES_PORT", "5433")))
    p.add_argument("--db", default=os.getenv("POSTGRES_DB", "fraud_db"))
    p.add_argument("--user", default=os.getenv("POSTGRES_USER", "postgres"))
    p.add_argument("--password", default=os.getenv("POSTGRES_PASSWORD", "postgres"))
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--purge-first",
        action="store_true",
        help="DELETE FROM transactions WHERE transactionId LIKE 'paysim-%%' before ingest",
    )
    args = p.parse_args()

    if not PAYSIM_PATH.exists():
        sys.exit(f"PaySim CSV not found at {PAYSIM_PATH}")

    rng = random.Random(args.seed)

    print(f"Reading PaySim CSV from {PAYSIM_PATH} …")
    fraud_rows = []
    legit_rows = []
    with PAYSIM_PATH.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            is_fraud = int(row["isFraud"]) == 1
            target = fraud_rows if is_fraud else legit_rows
            target.append(row)
    print(f"  fraud rows in source: {len(fraud_rows)}  legit rows in source: {len(legit_rows)}")

    target_fraud = int(args.rows * 0.001 * args.fraud_multiplier)
    target_fraud = min(target_fraud, len(fraud_rows))
    target_legit = max(0, args.rows - target_fraud)
    target_legit = min(target_legit, len(legit_rows))

    sample_fraud = rng.sample(fraud_rows, target_fraud)
    sample_legit = rng.sample(legit_rows, target_legit)
    rows = sample_fraud + sample_legit
    rng.shuffle(rows)
    print(f"  sampled: {len(sample_fraud)} fraud + {len(sample_legit)} legit = {len(rows)} total")
    print(f"  effective fraud rate: {len(sample_fraud)/len(rows):.4%}")

    conn = psycopg2.connect(
        host=args.host, port=args.port, dbname=args.db, user=args.user, password=args.password
    )
    conn.autocommit = False
    cur = conn.cursor()

    if args.purge_first:
        cur.execute("DELETE FROM transactions WHERE \"transactionId\" LIKE 'paysim-%%'")
        print(f"  purged {cur.rowcount} prior paysim rows")

    insert_sql = """
        INSERT INTO transactions (
            "transactionId", "senderId", "receiverId", amount, "transactionType",
            "timestamp", "fraudLabel", "decisionSource",
            "walletBalance"
        ) VALUES (
            %(transactionId)s, %(senderId)s, %(receiverId)s, %(amount)s, %(transactionType)s,
            %(timestamp)s, %(fraudLabel)s, %(decisionSource)s,
            %(walletBalance)s
        )
        ON CONFLICT ("transactionId") DO NOTHING
    """

    batch = []
    BATCH_SIZE = 1000
    inserted = 0
    for i, row in enumerate(rows):
        step = int(row["step"])
        ts_ms = int((EPOCH + timedelta(hours=step)).timestamp() * 1000)
        batch.append({
            "transactionId": f"paysim-{i:08d}-{uuid.uuid4().hex[:6]}",
            "senderId": row["nameOrig"],
            "receiverId": row["nameDest"],
            "amount": round(float(row["amount"]), 2),
            "transactionType": row["type"],
            "timestamp": ts_ms,
            "fraudLabel": int(row["isFraud"]) == 1,
            "decisionSource": "ML",
            "walletBalance": round(float(row["oldbalanceOrg"]), 2),
        })
        if len(batch) >= BATCH_SIZE:
            cur.executemany(insert_sql, batch)
            inserted += len(batch)
            batch = []
            if (i + 1) % 10_000 == 0:
                print(f"  inserted {i+1}/{len(rows)}")
    if batch:
        cur.executemany(insert_sql, batch)
        inserted += len(batch)

    conn.commit()
    cur.close()
    conn.close()
    print(f"✅ Done. Inserted ~{inserted} rows (ON CONFLICT may have skipped some).")


if __name__ == "__main__":
    main()
