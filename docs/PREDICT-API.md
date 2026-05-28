# `POST /v1/predict` — full field reference

The request shape is the single source of truth for what the feature
catalogue can consume. The README's quickstart curl shows only the six
required core fields; everything below is optional context that
improves prediction quality when supplied.

Source of truth: [`src/v1/modules/rda/dtos/predict-request.dto.ts`](../src/v1/modules/rda/dtos/predict-request.dto.ts)
and [`src/v1/modules/rda/validations/predict.validator.ts`](../src/v1/modules/rda/validations/predict.validator.ts).

## Headers

| Header                | Required                                  | Notes |
|---|---|---|
| `Content-Type`        | yes                                       | `application/json`. |
| `X-Api-Key`           | yes when `RDA_REQUIRE_API_KEY=true`       | Issued via `POST /v1/admin/api-keys`. Format `fdk_<prefix>_<secret>`. |
| `Idempotency-Key`     | optional                                  | Max 128 chars. Same key + same body within 24 h returns the cached response with `Idempotency-Replay: true`. Same key + different body returns 422. |
| `X-Correlation-ID`    | optional                                  | Echoed back as `X-Correlation-ID`; used as the trace id in logs. |
| `X-Tenant-ID`         | optional, requires a verified credential  | Scopes the request to a non-default tenant. Ignored when no API key / JWT is present. |

## Required fields

| Field             | Type    | Constraints                                                  | Notes |
|---|---|---|---|
| `transaction_id`  | string  | 10–255 chars                                                 | Caller-controlled identifier. Free-form string — UUID, ULID, PSP txn ref, order id, your own format — as long as it's at least 10 chars and unique within your tenant. Echoed in the response, persisted on the audit row and the `transactions` row (`UNIQUE` constraint on the latter), indexed for fast lookup, and searchable from the audit list. There is no separate `reference` field; pick a format and use this one. Pass the same value as `Idempotency-Key` if you want replay-safety. |
| `sender_id`       | string  | 1–255 chars                                                  | Stable id for the originator. Used to look up Redis features. |
| `receiver_id`     | string  | 1–255 chars                                                  | Stable id for the counterparty. |
| `amount`          | number  | `0.01 ≤ x ≤ 9_999_999_999`                                   | Use `currency` to disambiguate per call. |
| `transaction_type`| enum    | `CASH_IN` \| `CASH_OUT` \| `PAYMENT` \| `TRANSFER` \| `DEBIT`| Consumed by both the model and the rules engine. |
| `timestamp`       | number  | Unix ms, `0 ≤ x ≤ 9_999_999_999_999`                         | Drives every temporal feature. |

## Optional context

Every field below is `?` in the DTO and free to omit. The feature
catalogue substitutes per-feature defaults for anything missing —
but supplying it materially improves precision, especially on
first-touch users where the Redis snapshot is sparse.

### Segmenting

| Field    | Type   | Notes |
|---|---|---|
| `segment`| string, ≤100 chars | Routes the request through the model registry's per-segment threshold map. Defaults to the global threshold when absent. |

### Display names

| Field                      | Type                | Notes |
|---|---|---|
| `customer_account_name`    | string, ≤255 chars  | Display name for the sender chip in Sentinel. Account numbers (`sender_id`) are typically numeric and don't yield readable initials — use this to give the operator a name to read. Persisted on `transactions`. |
| `beneficiary_account_name` | string, ≤255 chars  | Display name for the receiver chip. Same rationale as `customer_account_name`. |

### Identity

| Field                  | Type    | Notes |
|---|---|---|
| `customer_dob`         | string, ≤32 chars         | ISO-8601 date (`YYYY-MM-DD`). |
| `customer_nationality` | string, ≤8 chars          | ISO-3166 alpha-2 (`NG`, `GB`, …). |
| `customer_type`        | `INDIVIDUAL` \| `CORPORATE` | |
| `customer_id_type`     | string, ≤32 chars         | `BVN` \| `NIN` \| `PASSPORT` \| your own. |
| `customer_id_number`   | string, ≤64 chars         | |
| `account_age_days`     | number, ≥0                | |
| `is_authenticated`     | boolean                   | Whether the originating session was MFA-authenticated. |

### Channel + currency

| Field         | Type                        | Notes |
|---|---|---|
| `channel`     | string, ≤32 chars           | `USSD` \| `MOBILE` \| `WEB` \| `AGENT` \| your own. |
| `currency`    | string, ≤8 chars            | ISO-4217 alpha-3 (`NGN`, `USD`, …). |
| `is_inflow`   | boolean                     | Direction of funds from the sender's perspective. |
| `is_recurring`| boolean                     | Scheduled / standing-order marker. |

### Wallet

| Field            | Type        | Notes |
|---|---|---|
| `wallet_balance` | number, ≥0  | Sender's balance at request time. Drives `amount_vs_balance_ratio` and related features. |

### Geographic

| Field                 | Type                | Notes |
|---|---|---|
| `customer_latitude`   | -90 ≤ x ≤ 90        | Where the sender lives (registered address). |
| `customer_longitude`  | -180 ≤ x ≤ 180      | |
| `transaction_country` | string, ≤8 chars    | ISO-3166 alpha-2 — where the transaction was initiated. |
| `destination_country` | string, ≤8 chars    | ISO-3166 alpha-2 — where it's landing. |
| `ip_country`          | string, ≤8 chars    | Resolved from the requesting IP. |
| `transaction_lat`     | -90 ≤ x ≤ 90        | Lat of the transaction itself (often device-reported). |
| `transaction_lng`     | -180 ≤ x ≤ 180      | |

### Device / session

| Field                    | Type             | Notes |
|---|---|---|
| `ip_is_vpn`              | boolean          | |
| `device_is_trusted`      | boolean          | Whether your stack has previously seen this device as the sender's. |
| `device_type`            | string, ≤32 chars| `MOBILE` \| `DESKTOP` \| `TABLET` \| your own. |
| `session_to_txn_seconds` | number, ≥0       | Time between session start and this transaction. |
| `device_fingerprint`     | object           | See nested fields below. |
| `device_fingerprint.browser`           | string, ≤255 chars  | UA family or string. |
| `device_fingerprint.os`                | string, ≤255 chars  | OS family. |
| `device_fingerprint.screen_resolution` | string, ≤50 chars   | `1920x1080`, `375x812`, … |

### Agent (mobile-money)

| Field                 | Type             | Notes |
|---|---|---|
| `agent_id`            | string, ≤64 chars| Stable id for the agent (if the transaction was made through one). |
| `agent_latitude`      | -90 ≤ x ≤ 90     | |
| `agent_longitude`     | -180 ≤ x ≤ 180   | |
| `agent_battery_level` | 0 ≤ x ≤ 100      | Low battery is a known agent-collusion signal. |

### Receiver (recipient context)

These fields drive the `recipient_*` features — the recipient half of
the graph that PAA would otherwise have to wait for the next
transaction to learn.

| Field                  | Type             | Notes |
|---|---|---|
| `recipient_dob`        | string, ≤32 chars| ISO-8601 date. |
| `recipient_nationality`| string, ≤8 chars | ISO-3166 alpha-2. |
| `recipient_id_type`    | string, ≤32 chars| |
| `recipient_id_number`  | string, ≤64 chars| |
| `customer_fi`          | string, ≤64 chars| Sender's financial institution id. |
| `recipient_fi`         | string, ≤64 chars| Recipient's financial institution id. |

### Adopter overflow

`request_context` (object, untyped in the DTO) — any extra
adopter-defined fields. Passed through to PAA + the audit row
unchanged. Read by the custom-feature hook on both sides; bring
your own features through here without touching the catalogue.

## Response

```json
{
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "fraud": false,
  "fraud_probability": 0.1842,
  "decision": "ACCEPT",
  "decision_source": "ML",
  "reason_codes": [
    { "code": "AMOUNT_HIGH",  "description": "...", "contribution":  0.27, "value": 1500.0 },
    { "code": "VELOCITY_24H", "description": "...", "contribution": -0.05, "value": 4.0 }
  ],
  "model_version": "default",
  "threshold": 0.65,
  "rule": { "id": "...", "name": "...", "stage": "PRE" },
  "audit_id": "f3d7c0bc-...",
  "latency_ms": 3,
  "timestamp": 1717718400123
}
```

| Field               | Type                                          | Notes |
|---|---|---|
| `fraud`             | boolean                                       | `decision === "DECLINE"`. |
| `fraud_probability` | 0 ≤ x ≤ 1                                     | Champion-model probability, rounded to 4 dp. |
| `decision`          | `ACCEPT` \| `DECLINE` \| `REVIEW`             | Final, post-rule. |
| `decision_source`   | `ML` \| `PRE_RULE` \| `POST_RULE`             | Which layer made the call. |
| `reason_codes`      | array                                         | Top contributing features. See [`docs/REASON-CODES.md`](REASON-CODES.md). |
| `model_version`     | string                                        | The champion that scored this request. |
| `threshold`         | number                                        | Threshold used for this segment + model. |
| `rule`              | object \| undefined                           | Present when `decision_source !== "ML"`. |
| `audit_id`          | uuid \| undefined                             | Foreign key into `decisionAuditLog`. Absent only when the audit write failed (which is swallowed by design — see [`docs/AUDIT.md`](AUDIT.md)). |
| `latency_ms`        | number                                        | End-to-end service time, not including network. |
| `timestamp`         | number                                        | Server-side reply time, Unix ms. |

### Response headers

| Header                 | When                                            | Notes |
|---|---|---|
| `X-Correlation-ID`     | always                                          | Echoes the request `X-Correlation-ID` or a generated `req-<uuid>`. |
| `X-Response-Time`      | on a fresh prediction                           | `<n>ms` — matches `latency_ms`. |
| `Idempotency-Replay`   | only on a replay of an existing Idempotency-Key | Always `true` when present. |
| `Retry-After`          | 409 in-flight                                   | `1` — try again in a second. |

## Error responses

| Status | Cause | Body shape |
|---|---|---|
| 400    | Validation failure (missing required, type / range violation). | `{ status: false, message, errors: [{ field, message }] }` |
| 400    | `Idempotency-Key` > 128 chars. | `{ status: false, message }` |
| 401    | Missing API key when required. | `{ status: false, message }` |
| 409    | Another request with the same Idempotency-Key is still in flight. Retry. | `{ status: false, message }` + `Retry-After: 1` |
| 422    | Idempotency-Key reused with a different request body. | `{ status: false, message }` |
| 500    | Inference / audit / Kafka pipeline failed catastrophically. | `{ status: false, message }` |

## Sample request — full payload

Every documented field, validated end-to-end against the Docker-stack
RDA. Omit any block your integration doesn't have — the catalogue
substitutes defaults. `transaction_id` is caller-controlled — any
10–255 char string is accepted; use whatever format your upstream
system already issues (UUID, ULID, PSP txn ref, order id, …). Pass the
same value as `Idempotency-Key` if you want replay-safe POSTs.

```bash
curl -X POST http://localhost/v1/predict \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: trace-sample-001" \
  -H "Idempotency-Key: 11a4d0eb-4542-4374-9d7c-7d639c4b79a0" \
  -d '{
    "transaction_id": "11a4d0eb-4542-4374-9d7c-7d639c4b79a0",
    "sender_id": "2000000068",
    "receiver_id": "0250809717",
    "customer_account_name": "AYODEJI SAMUEL ABODUNRIN",
    "beneficiary_account_name": "MICHAEL ONYI",
    "amount": 30000.00,
    "transaction_type": "TRANSFER",
    "timestamp": 1779961621428,
    "segment": "high_value",

    "customer_dob": "1989-04-17",
    "customer_nationality": "NG",
    "customer_type": "INDIVIDUAL",
    "customer_id_type": "BVN",
    "customer_id_number": "0000000000",
    "account_age_days": 1284,
    "is_authenticated": true,

    "channel": "RETAIL",
    "currency": "NGN",
    "is_inflow": false,
    "is_recurring": false,
    "wallet_balance": 86300.40,

    "customer_latitude": 6.5244,
    "customer_longitude": 3.3792,
    "transaction_country": "NG",
    "destination_country": "NG",
    "ip_country": "NG",
    "transaction_lat": 6.5300,
    "transaction_lng": 3.3700,

    "ip_is_vpn": false,
    "device_is_trusted": true,
    "device_type": "MOBILE",
    "session_to_txn_seconds": 47,
    "device_fingerprint": {
      "browser": "Chrome 124",
      "os": "Android 14",
      "screen_resolution": "412x915"
    },

    "agent_id": "agent_lagos_lekki_27",
    "agent_latitude": 6.4350,
    "agent_longitude": 3.4715,
    "agent_battery_level": 73,

    "recipient_nationality": "NG",
    "recipient_id_type": "NIN",
    "customer_fi": "9japay",
    "recipient_fi": "gtbank",

    "request_context": {
      "narration": "FROM AYODEJI SAMUEL ABODUNRIN TO MICHAEL For food for the family",
      "provider": "nibssclassic",
      "transfer_type": "interbank"
    }
  }'
```

Notes on this sample:

- **`Idempotency-Key` reuses `transaction_id`.** Same value, two
  surfaces — the controller doesn't synthesise the key from anywhere
  in the body, so callers must opt into replay-safety explicitly with
  the header. Replaying the same body with the same key within 24 h
  returns the cached response with `Idempotency-Replay: true`.
- **`request_context.narration`** is surfaced prominently in
  Sentinel's transaction detail page; the rest of the object is
  passed through to PAA and the audit row unchanged.
- **`recipient_dob`** intentionally absent. The DTO accepts it for
  forward-compatibility, but the column was dropped from
  `transactions` on review — recipient age has minimal signal.
- **Agent lat/lng/battery** are accepted by the DTO but only
  `agent_id` survives persistence (see the migration comment in
  `20260515000001_extend_transactions_for_training.ts`).
