# Webhooks

RDA pushes signed POSTs to subscriber URLs when decisions or rules
change. Adopters use them to wire fraud outcomes into their case
management / ledger / customer-comms systems without polling.

## Events

| Event                | Fired when                                              |
|----------------------|---------------------------------------------------------|
| `decision.created`   | Any `/v1/predict` returns a decision (ACCEPT, DECLINE, REVIEW). |
| `decision.overridden`| A human reviewer overrides a decision via `POST /v1/decisions/:auditId/override`. |
| `model.activated`    | A model version transitions to `ACTIVE`.                |
| `rule.activated`     | A rule is created or toggled active. *(reserved — emitted by future rule admin endpoints; safe to subscribe today)* |

Each subscription declares which events it wants; non-matching events
are not enqueued.

## Subscribing

```bash
curl -X POST http://localhost:3000/v1/admin/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://acme.example.com/fraud-webhook",
    "events": ["decision.created", "decision.overridden"],
    "maxRetries": 6,
    "timeoutMs": 5000
  }'
```

Response (returned **exactly once**):

```json
{ "status": true, "data": { "id": "…", "secret": "whsec_…" } }
```

Store the secret — only its hash is persisted. The secret is used both
on the server (to sign outgoing requests) and on your side (to verify).

## Delivery semantics

- **At-least-once**: failed deliveries are retried with exponential
  backoff (30 s × 2^attempts, capped at 1 hour) up to `maxRetries`.
- **Ordered by enqueue time** *within a subscription*; cross-event
  ordering is best-effort.
- **One row per attempt** in `webhookDeliveries` — request body, response
  code, response body snippet, attempt count, next-attempt timestamp.
- A background worker (`startWebhookWorker` in `src/shared/webhooks/`)
  drains `PENDING` rows whose `nextAttemptAt` has passed, every
  `WEBHOOK_WORKER_INTERVAL_MS` (default 10 s).

## Payload shape

The outermost envelope is identical for every event:

```json
{
  "event": "decision.created",
  "data": { /* event-specific */ },
  "sent_at": "2026-05-13T12:34:56.789Z"
}
```

### `decision.created.data`

```json
{
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "sender_id": "user123",
  "receiver_id": "user456",
  "amount": 1500.0,
  "decision": "DECLINE",
  "decision_source": "ML",
  "model_version": "v1.1.0",
  "fraud_probability": 0.8732,
  "reason_codes": [
    { "code": "AMOUNT_HIGH",  "description": "…", "contribution": 0.31, "value": 1500.0 },
    { "code": "VELOCITY_24H", "description": "…", "contribution": 0.18, "value": 47   }
  ],
  "audit_id": "f3d7c0bc-…"
}
```

### `decision.overridden.data`

```json
{
  "audit_id": "f3d7c0bc-…",
  "transaction_id": "550e8400-…",
  "original_decision": "DECLINE",
  "override_decision": "ACCEPT",
  "reviewer": "analyst-7",
  "reason": "Customer verified on call"
}
```

## Signature scheme

Every delivery includes:

```
X-Webhook-Event: decision.created
X-Webhook-Signature: t=1715000000,v1=<hex>
```

`v1` is computed server-side as:

```
v1 = HMAC-SHA256(secret_hash, "<t>.<rawRequestBody>")
```

> **Important** — the server uses `sha256(secret)` as the HMAC key, not
> the original secret. Clients verify with `sha256(secret)` too. This
> means anyone who can read the database can forge a webhook; that's
> already a complete compromise, so it does not change the threat model.
> Future iterations can move to storing the raw secret under envelope
> encryption — file an issue if your compliance posture requires it.

### Verification — Node.js

```js
import crypto from "node:crypto";

const SECRET_HASH = crypto.createHash("sha256").update(process.env.WEBHOOK_SECRET).digest("hex");

function verify(req) {
  const [tPart, v1Part] = (req.headers["x-webhook-signature"] || "").split(",");
  const t = tPart.split("=")[1];
  const v1 = v1Part.split("=")[1];

  // Reject replays older than 5 minutes
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (skew > 300) return false;

  const expected = crypto.createHmac("sha256", SECRET_HASH).update(`${t}.${req.rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
}
```

### Verification — Python

```python
import hmac, hashlib, time

SECRET_HASH = hashlib.sha256(WEBHOOK_SECRET.encode()).hexdigest()

def verify(headers, raw_body: bytes) -> bool:
    sig = headers.get("X-Webhook-Signature", "")
    parts = dict(p.split("=", 1) for p in sig.split(","))
    if abs(int(time.time()) - int(parts["t"])) > 300:
        return False
    expected = hmac.new(
        SECRET_HASH.encode(),
        f"{parts['t']}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

## Inspecting delivery history

```sql
SELECT d.status, d.attempts, d."lastResponseCode", d."lastAttemptedAt",
       s.url, d.event
FROM "webhookDeliveries" d
JOIN "webhookSubscriptions" s ON s.id = d."subscriptionId"
WHERE d."createdAt" > now() - interval '24 hours'
ORDER BY d."createdAt" DESC
LIMIT 50;
```

`status` is one of `PENDING`, `DELIVERED`, `FAILED`. A row in `PENDING`
with a future `nextAttemptAt` is queued for retry; a row in `FAILED`
has exhausted its retry budget.

## Revoking a subscription

```bash
curl -X DELETE http://localhost:3000/v1/admin/webhooks/<id> \
  -H "Authorization: Bearer $TOKEN"
```

Pending deliveries belonging to a revoked subscription are skipped on
the next worker tick.
