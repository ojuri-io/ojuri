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

All endpoints below require an authenticated JWT (`Authorization: Bearer ...`)
with the listed permission. Full surface:

| Method + Path | Permission | Purpose |
|---|---|---|
| `POST /v1/admin/training/import` | `training:write` | Submit a `file://` source for staging. |
| `GET /v1/admin/training/imports` | `training:read` | List jobs (Sentinel UI uses this). |
| `GET /v1/admin/training/import/:jobId` | `training:read` | Single job — status, counters, up to 100 per-row errors. |
| `POST /v1/admin/training/import/:jobId/promote` | `training:write` | Promote a COMPLETED job's staging rows into `transactions`. |
| `POST /v1/admin/training/upload/init` | `training:write` | Begin a chunked upload (used by the Sentinel UI). |
| `PUT  /v1/admin/training/upload/:uploadId/chunk` | `training:write` | Send the next chunk (max 5 MB + 1 KB header). |
| `POST /v1/admin/training/upload/:uploadId/complete` | `training:write` | Assemble, verify, enqueue as a `training_import` job. |
| `POST /v1/admin/training/upload/:uploadId/abandon` | `training:write` | Discard an unfinished upload. |
| `GET  /v1/admin/training/upload/:uploadId` | `training:read` | Server's view of upload progress (bytes received, status). |

#### File-source import

```json
POST /v1/admin/training/import
Content-Type: application/json

{ "source": "file:///app/data/training-imports/labels.csv" }
```

Server stream-parses the file into `transactionsStaging`, returns
`{ "jobId": "..." }`. The background `TrainingImportWorker` polls
`status='QUEUED'` rows every 2 seconds and processes one at a time.

#### Chunked-upload protocol

The Sentinel UI uses this; you can drive it directly for adopter-owned
clients (Python, Go, etc.) that need to upload from outside the docker
host.

1. **`POST /upload/init`** — body `{ "filename": "labels.csv", "expectedBytes": 1234567 }`. Returns `{ "uploadId": "...", "chunkSize": 5242880 }`. The server allocates an empty chunk directory under `data/training-uploads/<uploadId>/`.
2. **`PUT /upload/:uploadId/chunk`** — body is `application/octet-stream` of `chunkSize` bytes. The `Content-Range: bytes <offset>-<end>/<total>` header drives offset tracking. Sequential offsets only; out-of-order returns 409.
3. **`POST /upload/:uploadId/complete`** — body `{ "sha256": "<hex>", "transformSpec": { "headerMap": {...}, "columnDefaults": {...}, "dropEmptyRows": true } }`. Server concatenates chunks via streaming read, verifies SHA-256 if provided, persists the assembled file under `data/training-uploads/<uploadId>/assembled.csv`, and creates a `trainingJobs` row pointing at it via `file://`. `transformSpec` is stored on the row so the worker applies the same renames + defaults during stream parsing.
4. **`POST /upload/:uploadId/abandon`** — best-effort cleanup. Idempotent.

Sessions auto-abandon after 1 hour of inactivity. The `data/training-uploads/`
directory is bind-mounted into the RDA container (RW) in the shipped
`docker-compose.yml`.

#### Promote staging → transactions

```
POST /v1/admin/training/import/:jobId/promote
```

Only allowed when `status='COMPLETED'`. The promote step runs an upsert
into `transactions` keyed on `(tenantId, transactionId)`:

- `groundTruthSource` is set to `'training_import'` so the row is
  distinguishable from reviewer-overridden ground truth.
- `groundTruthFraud` takes the CSV's `groundTruthFraud` if present,
  otherwise `fraudLabel`.
- `promotedAt`, `promotedBy`, and `promotedRows` are written back to the
  `trainingJobs` row.

Re-promoting is a no-op (already promoted rows are skipped via
`ON CONFLICT DO UPDATE` predicates).

#### Triggering a retrain on the promoted data

Once promotion finishes, ask MLA to retrain:

```
POST /mla/v1/admin/retrain
```

Requires `mla:configure`. The endpoint returns 202 with a `runId`; the
retrain itself runs in the background (Kafka-driven A/B + McNemar
gate, same as drift-triggered runs). Poll `GET /mla/v1/admin/retrain-runs`
for status. If the new candidate fails the A/B gate the current production
model stays in place — the operator sees a `KEEP_CURRENT_MODEL` row in
`retrainRuns` and the `failureReason` explains why.

S3 (`s3://bucket/key.csv`) sources return **501 Not Implemented** today —
adopters that need it should download to a host-local path under
`data/training-imports/` and submit as `file://`.

### CSV contract

The staging schema below describes what the server expects in each row
*after* the `transformSpec` is applied. Each "Required" column can be
satisfied in **any** of three ways:

- The column is in the CSV under its canonical name (e.g. a `transactionId` header).
- The column is in the CSV under a different name and you point a `headerMap` entry at it (`{"txn_id": "transactionId"}`).
- The column is missing and you supply a `columnDefaults` entry that's applied to every row (`{"currency": "NGN"}`).

So in practice, a CSV with only `txn_id, sender_id, receiver_id, amt, txn_type, ts, fraud_label` is fine *if* the transformSpec renames each field to its canonical name. The Sentinel UI ("Fix columns without re-exporting") is just a visual front end for the same JSON.

| Canonical column | Required | Type | Notes |
|---|---|---|---|
| `transactionId` | yes | string | Unique within the batch |
| `senderId` | yes | string | |
| `receiverId` | yes | string | |
| `amount` | yes | numeric > 0 | |
| `transactionType` | yes | string | `CASH_IN`/`CASH_OUT`/`PAYMENT`/`TRANSFER`/`DEBIT` |
| `timestamp` | yes | unix-ms | |
| `groundTruthFraud` | one-of | bool | Preferred label (verified) |
| `fraudLabel` | one-of | bool | System fallback label — at least one of the two label columns must resolve |
| `channel` | no | string | |
| `currency` | no | string | Default-able via `columnDefaults` |
| `accountAgeDays` | no | int | |
| `ipCountry` | no | ISO-3166 | |
| `transactionCountry` | no | ISO-3166 | |
| `sessionToTxnSeconds` | no | int | |
| `deviceIsTrusted` | no | bool | |
| `isAuthenticated` | no | bool | |

Booleans accept `true/false`, `1/0`, `yes/no` (case-insensitive).

To get an empty CSV with the canonical headers, click **Download template** on the Sentinel Training imports page or curl `GET /v1/admin/training/template.csv`.

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

## 4. Ongoing labels (chargebacks, disputes, customer reports)

For verified fraud outcomes as they happen:

```
POST /v1/admin/labels          (requires the labels:write permission)
{
  "labels": [
    { "transaction_id": "tx-123", "is_fraud": true,  "source": "chargeback" },
    { "transaction_id": "tx-456", "is_fraud": false, "source": "dispute" }
  ]
}
```

- Up to 1,000 labels per request; duplicates within a batch collapse
  last-wins. `source` is one of `chargeback`, `dispute`,
  `customer_report`, `reviewer_override`, `training_import`.
- Labels upsert `transactions.groundTruthFraud` — re-sending the same
  `transaction_id` overwrites the previous verdict (chargeback reversals
  just get pushed again with the corrected `is_fraud`).
- The response reports `unmatched` transaction ids (no matching
  `transactions` row yet — e.g. PAA hasn't flushed it). Retry those
  after a minute.

MLA retrains automatically once `LABEL_RETRAIN_THRESHOLD` (default 500)
new labels accumulate, checked every `LABEL_CHECK_INTERVAL_SECONDS`
(default 900). Set the threshold to 0 to disable and rely on drift /
manual retrains only. Reviewer overrides in Sentinel keep flowing
through the same ground-truth columns via
`POST /v1/admin/audit/:auditId/override`.

For high-volume label streams, publish to a Kafka topic `labels.received`
that MLA consumes — design TBD; needs the topic + consumer wired.
