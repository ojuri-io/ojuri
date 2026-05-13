# Idempotency

`/v1/predict` accepts an `Idempotency-Key` header. When set, the
endpoint guarantees that retrying the same request returns the same
response — useful for clients that can't tell whether their first
attempt landed (network hiccup, timeout, ambiguous failure).

## How clients use it

Send a random UUID v4 (or any string ≤ 255 chars) in the header:

```
POST /v1/predict
Idempotency-Key: 6e0d6c8e-a7f7-4f1a-94a1-3c8d0a2c0a01
```

- **First call** with a given key: runs the full prediction pipeline
  and persists the response.
- **Replay** (same key, same body): returns the previously persisted
  response. `Idempotency-Replay: true` is set on the response.
- **Conflict** (same key, *different* body): rejected with `422
  Unprocessable Entity`. This catches the bug of accidentally reusing
  a key across logically distinct requests.

## Scoping

The key is scoped by `(tenantId, key)`:

- If the request comes with an API key, `tenantId = apiKey.tenantId`.
- Otherwise, `tenantId` falls back to the `X-Tenant-Id` header.
- Otherwise, `tenantId = "default"`.

Single-tenant self-hosted deployments don't need to think about this —
every request shares the `"default"` namespace.

## TTL

Cached responses live for `IDEMPOTENCY_TTL_MS` (default 24 hours,
configurable via env). After that, the same key can be reused for a
new request without conflict. Expired rows are not yet auto-purged;
run a periodic cleanup if disk pressure matters:

```sql
DELETE FROM "idempotencyKeys" WHERE "expiresAt" < now();
```

## What gets compared

The request body is hashed with SHA-256 of its JSON form. Any change
to any field counts as "different request". That includes
`timestamp` — if your retry path regenerates the timestamp, you'll
hit a 422. Either:

- Capture the timestamp once when constructing the request, or
- Treat a 422 as "this key already maps to a different request,
  generate a new key".

## Storage

Table `idempotencyKeys`:

| Column        | Notes                                         |
|---------------|-----------------------------------------------|
| `key`         | The header value.                             |
| `tenantId`    | Scope.                                        |
| `requestHash` | SHA-256 of the JSON body.                     |
| `response`    | JSONB — the exact response the client got.    |
| `expiresAt`   | TTL.                                          |

Primary key is `(tenantId, key)`.

## Failure isolation

Storing the idempotency record is best-effort — if Postgres is briefly
unreachable, the prediction still succeeds and the response is sent,
but a retry within TTL will *not* replay. The audit log row is the
durable record either way.
