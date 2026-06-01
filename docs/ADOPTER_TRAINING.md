# Loading training data as an adopter

The MLA service trains XGBoost on rows in the `transactions` table where
`groundTruthFraud` (preferred) or `fraudLabel` is set. Three channels are
supported for getting your labelled data in. Pick the one that matches your
operational shape.

## 1. Bulk backfill via the import API

For one-time loads of historical labelled data (typically 100k–10M rows).

`POST /v1/admin/training/import` — requires `training:write` permission.

Body:

```json
{ "source": "file:///absolute/path/to/labels.csv" }
```

Server-side stream-parses the file into a staging table (`transactionsStaging`),
returns a job id. Promotion from staging to `transactions` is a separate
explicit step (TBD — runs out-of-band so a bad batch is recoverable).

`GET /v1/admin/training/import/:jobId` — status, counters, per-row errors
(up to 100).

S3 (`s3://bucket/key.csv`) returns **501 Not Implemented** today — adopters
that need it should download to a host-local path and submit as `file://`.

### CSV contract

| Column | Required | Type | Notes |
|---|---|---|---|
| `transactionId` | yes | string | Unique within the batch |
| `senderId` | yes | string | |
| `receiverId` | yes | string | |
| `amount` | yes | numeric > 0 | |
| `transactionType` | yes | string | `CASH_IN`/`CASH_OUT`/`PAYMENT`/`TRANSFER`/`DEBIT` |
| `timestamp` | yes | unix-ms | |
| `groundTruthFraud` | one-of | bool | Preferred label (verified) |
| `fraudLabel` | one-of | bool | System fallback label |
| `channel` | no | string | |
| `currency` | no | string | |
| `accountAgeDays` | no | int | |
| `ipCountry` | no | ISO-3166 | |
| `transactionCountry` | no | ISO-3166 | |
| `sessionToTxnSeconds` | no | int | |
| `deviceIsTrusted` | no | bool | |
| `isAuthenticated` | no | bool | |

Booleans accept `true/false`, `1/0`, `yes/no` (case-insensitive).

## 2. Direct Postgres COPY (technical adopters)

If you control the Postgres host and prefer not to go through the API:

```sh
psql "$DB_URL" -c "\copy \"transactions\"( \
  \"transactionId\", \"senderId\", \"receiverId\", \
  amount, \"transactionType\", timestamp, \
  \"groundTruthFraud\" \
) FROM 'labels.csv' WITH CSV HEADER"
```

Fastest path. No staging table, no validation — bad rows kill the COPY,
fix the CSV and retry.

## 3. Ongoing labels via webhook (not bulk)

For chargebacks / reviewer overrides as they happen:

`POST /v1/admin/labels` (not yet implemented) — idempotent by `transactionId`.
Until shipped, use the existing `POST /v1/admin/audit/:auditId/override` flow,
which writes ground truth via the override path.

For high-volume label streams, publish to a Kafka topic `labels.received`
that MLA consumes — design TBD; needs the topic + consumer wired.
