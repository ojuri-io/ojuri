# Loading training data as an adopter

The MLA service trains XGBoost on rows in the `transactions` table where
`groundTruthFraud` (preferred) or `fraudLabel` is set. Four channels are
supported for getting your labelled data in. Pick the one that matches your
operational shape.

## 1. Sentinel UI upload (recommended for ad-hoc imports)

Open **Training data** in the Sentinel sidebar. The page lets you:

1. Attach a CSV — the browser parses the first 50 rows locally so you see
   the exact columns and a sample of data before sending anything.
2. Column coverage is rendered: required columns (green ✓ or red ✗), label
   column (`groundTruthFraud` or `fraudLabel` — at least one must be
   present), and any optional columns that were detected.
3. Click **Upload and queue** — the file streams to the server in 5 MB
   chunks via `PUT /v1/admin/training/upload/:uploadId/chunk`. A progress
   bar updates per chunk so you can see exactly how far through you are.
4. On completion, the server reassembles the chunks, validates the total
   byte count (and SHA-256 if you provided one), then enqueues an import
   job pointing at the assembled file. The jobs table on the same page
   polls every 4s so you see status transition QUEUED → RUNNING → COMPLETED.

Size cap defaults to **5 GB per upload**; chunk size and cap are env
configurable (`TRAINING_UPLOAD_CHUNK_SIZE`, `TRAINING_UPLOAD_MAX_BYTES`).
Sessions abandon themselves after 1 hour of no activity.

### Fixing column issues without re-exporting

If the preview shows missing required columns, expand **"Fix columns
without re-exporting"** under the column-coverage row. The panel lets
you either:

- **Map a source column** to the canonical name. Example: your CSV has
  `txn_id` but the API expects `transactionId` — select `txn_id` from
  the dropdown next to `transactionId`. The whole file is renamed on
  the server during parse.
- **Provide a default value** that's written into every row. Example:
  the CSV lacks `currency` — type `NGN` and every row gets `NGN`.

A toggle for **Drop fully empty rows** is on by default. The full
transform spec is sent on `POST /v1/admin/training/upload/:id/complete`
as `{ "transformSpec": { headerMap, columnDefaults, dropEmptyRows } }`
and persists on the `trainingJobs.transformSpec` column so you can see
exactly what transforms were applied to a historical import.

## 2. Bulk backfill via the import API (server-side path)

For one-time loads of historical labelled data (typically 100k–10M rows).

### Where to put the CSV

The RDA process runs inside a Docker container — your laptop's filesystem
is invisible to it. The shipped `docker-compose.yml` mounts
`./data/training-imports/` on the host to `/app/data/training-imports/`
inside every RDA replica (read-only).

1. Drop `labels.csv` (or whatever name) in `data/training-imports/` on the host.
2. Submit `file:///app/data/training-imports/labels.csv` as the source.

For non-compose deployments (Kubernetes, plain Docker, bare-metal) mount
your own path and submit whatever absolute path the RDA process can read
— the platform doesn't care about the host layout, only that the file
exists at the path it sees.

### API

`POST /v1/admin/training/import` — requires `training:write` permission.

Body:

```json
{ "source": "file:///app/data/training-imports/labels.csv" }
```

Server-side stream-parses the file into a staging table (`transactionsStaging`),
returns a job id. Promotion from staging to `transactions` is a separate
explicit step (TBD — runs out-of-band so a bad batch is recoverable).

`GET /v1/admin/training/imports` — list all import jobs (Sentinel UI uses this).
`GET /v1/admin/training/import/:jobId` — single-job status, counters,
per-row errors (up to 100).

S3 (`s3://bucket/key.csv`) returns **501 Not Implemented** today — adopters
that need it should download to a host-local path under
`data/training-imports/` and submit as `file://`.

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

## 3. Direct Postgres COPY (technical adopters)

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

## 4. Ongoing labels via webhook (not bulk)

For chargebacks / reviewer overrides as they happen:

`POST /v1/admin/labels` (not yet implemented) — idempotent by `transactionId`.
Until shipped, use the existing `POST /v1/admin/audit/:auditId/override` flow,
which writes ground truth via the override path.

For high-volume label streams, publish to a Kafka topic `labels.received`
that MLA consumes — design TBD; needs the topic + consumer wired.
