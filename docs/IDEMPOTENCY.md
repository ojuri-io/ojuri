# Idempotency

`POST /v1/predict` accepts an `Idempotency-Key` header. When set, the
endpoint guarantees that retrying the same request returns the same
response — useful for clients that can't tell whether their first
attempt landed (network hiccup, timeout, ambiguous failure).

## How clients use it

Send any string ≤ 128 chars (a UUID v4 is fine):

```
POST /v1/predict
Idempotency-Key: 6e0d6c8e-a7f7-4f1a-94a1-3c8d0a2c0a01
```

- **First call** with a given key: runs the full pipeline, returns
  the response, and writes a Redis cache entry.
- **Replay** (same key, same body): returns the cached response.
  `Idempotency-Replay: true` is set on the response header.
- **Conflict** (same key, *different* body): rejected with
  `422 Unprocessable Entity`. Catches the bug of accidentally reusing
  a key across logically distinct requests.
- **In-flight** (same key, another request still running): the second
  request waits ~3 s for the first to finish; if not, it returns
  `409 Conflict` + `Retry-After: 1`.

## Scoping

The storage key is composite: `(tenantId, apiKeyId|"anon", rawKey)`.

- `tenantId` comes from the verified API key first, then from a JWT
  subject if present, then `X-Tenant-Id` (only honored when a
  credential is verified), then `"default"`.
- `apiKeyId` is included so two unrelated clients of the same tenant
  who happen to share an Idempotency-Key value get isolation —
  without it, callerA's response (including `fraud_probability` and
  `reason_codes`) would leak to callerB on the first replay.
- The raw `Idempotency-Key` header value.

Single-tenant self-hosted deployments don't need to think about this —
every request shares the `"default"` namespace with their key id.

## What gets compared

The request body is hashed with SHA-256 over its JSON form. Any field
change (including `timestamp`!) counts as "different request" and
returns 422. Either:

- Capture the timestamp once when constructing the request, or
- Treat 422 as "this key already maps to a different request, mint a
  new key."

## Storage

Two key families in Redis:

| Key                                                   | Purpose                                 | TTL                                  |
|---|---|---|
| `ojuri:idem:resp:<tenant>:<apiKeyOrAnon>\|<rawKey>`   | Response cache (JSON of `{requestHash, response}`) | `IDEMPOTENCY_TTL_MS`, default 24 h   |
| `ojuri:idem:lock:<tenant>:<apiKeyOrAnon>\|<rawKey>`   | Distributed lock during in-flight inference        | 15 s (fixed)                         |
| `ojuri:idem:tenant:<tenant>`                          | Sorted set tracking that tenant's live keys (for the cap) | TTL of the longest-lived entry + 60 s |

The lock is acquired with `SET … EX 15 NX` and released via a
CAS Lua script (so a slow leader can't release a fresh lock).

## Sizing

Per response entry, uncompressed: **~1–2 KB** (mostly the
`reason_codes` array's descriptions). Per key family above the value
adds ~150 bytes of overhead (key string + Redis key metadata).

| Request rate (with Idempotency-Key) | Keys / 24 h | Storage @ 1.5 KB avg |
|---|---|---|
| 10 req/s   | 864 k    | ~1.3 GB  |
| 100 req/s  | 8.6 M    | ~13 GB   |
| 1000 req/s | 86 M     | ~130 GB  |

## Bloat controls

Four knobs, all `env`-tunable:

| Env var                                | Default        | Effect |
|---|---|---|
| `IDEMPOTENCY_TTL_MS`                   | `86400000` (24 h) | Per-entry TTL. Lower to 1 h (`3600000`) or 15 min (`900000`) for high-volume tenants. |
| `IDEMPOTENCY_COMPRESS`                 | `false`        | gzip + base64 of the response JSON. ~40–60 % size reduction on typical reason-code-heavy payloads, sub-ms CPU cost. Recommended at >100 req/s. |
| `IDEMPOTENCY_MAX_KEYS_PER_TENANT`      | `10000`        | Per-tenant cardinality cap. When exceeded, the oldest entries for that tenant are evicted. Prevents a single noisy tenant filling the cache for everyone. |
| (Redis memory cap)                     | `2gb` in compose | `--maxmemory 2gb --maxmemory-policy volatile-lru` in `docker-compose.yml`. Under pressure, the LRU TTL'd keys go first — and every idempotency entry has a TTL, so they're exactly the right things to evict. |

The cap, compression, and per-entry TTL are independent — set them
to match your traffic shape and the headroom you want.

## Failure isolation

- A Redis write that fails is **logged and ignored** — the prediction
  still succeeds, the response is sent, but a retry within the
  window will not replay (it will recompute). The `decisionAuditLog`
  row remains the durable record.
- A Redis read that returns junk (corrupted compression, garbled
  JSON) is treated as a cache miss with a warning logged.
- The 15 s lock TTL guards against a leader crash leaving the lock
  dangling.

## Observability

The metrics endpoint (`GET /v1/metrics`) exposes:

| Metric                                              | Labels                                       | Notes                                                     |
|---|---|---|
| `fraud_detection_idempotency_lookups_total`         | `outcome=hit\|miss\|conflict\|in_flight`     | Tracks cache effectiveness and contention                 |
| `fraud_detection_idempotency_stores_total`          | `compressed=true\|false`                     | Lets you watch the effect of toggling `IDEMPOTENCY_COMPRESS` |
| `fraud_detection_idempotency_evictions_total`       | —                                            | Per-tenant cap evictions; sustained non-zero = tenant is over the cap |

A useful dashboard query: hit rate over time, and evictions broken
out of total stores. If evictions climb relative to stores, either
raise the per-tenant cap or audit the tenant for an integration that
generates unique keys per request when it should be deterministic.
