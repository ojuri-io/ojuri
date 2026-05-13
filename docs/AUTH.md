# Authentication & Authorization

This document describes the API-key model used by RDA, the admin gate,
and the per-key rate limit.

## Threat model

The platform is designed to be **self-hosted** by the adopting company.
Auth therefore protects two distinct surfaces:

- **`/v1/predict` and read-only audit endpoints** — accessed by application
  code embedded in the adopter's payment flow. Authenticated with a
  long-lived API key.
- **`/v1/admin/*`** — used by operators to issue keys, register models,
  edit rules, etc. Gated by a single static admin token (`RDA_ADMIN_TOKEN`).

There is **no per-user RBAC**, no OIDC, no group membership. That's
deliberate — adopters tend to wrap the admin API behind their own
internal SSO proxy or restrict it to a private network. Pull-requests
that bolt on OIDC are welcome but the open-source minimum is "static
token, kept off the public internet".

## API-key format

Tokens look like:

```
fdk_<12-hex-prefix>_<32-byte-base64url-secret>
```

- `fdk_` — fixed namespace marker so accidental leaks are searchable.
- `keyPrefix` — 12-character random hex stored in plaintext so logs can
  identify a key without revealing the secret. Always safe to log.
- `secret` — 24 random bytes encoded as base64url. The server only ever
  stores `sha256(token)`, never the raw secret.

## Issuing a key

```bash
curl -X POST http://localhost:3000/v1/admin/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -d '{
    "name": "prod-1",
    "rateLimitPerMinute": 1200,
    "scope": "predict",
    "tenantId": "default",
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

Required: `name`. Everything else is optional:

| Field                | Default      | Meaning |
|----------------------|--------------|---------|
| `tenantId`           | `"default"`  | Logical partition. Single-tenant deployments leave this alone. |
| `scope`              | `"predict"`  | Intended use of the key. Currently informational. |
| `rateLimitPerMinute` | `600`        | Token-bucket capacity per key. |
| `expiresAt`          | `null`       | ISO timestamp. After this, the key fails closed. |

Response (returned **exactly once**):

```json
{
  "status": true,
  "data": { "id": "f3a0…", "token": "fdk_…", "keyPrefix": "9c3a…" }
}
```

After the response you only have the hash. Lost keys must be rotated.

## Authenticating a request

Two equivalent headers:

```
X-Api-Key: fdk_…
```
or
```
Authorization: Bearer fdk_…
```

`apiKeyMiddleware` (`src/shared/middlewares/api-key.middleware.ts`):

1. Pulls the token from either header.
2. Hashes with `sha256` and looks up `apiKeys.keyHash`.
3. Rejects with `401` if missing, revoked, expired, or inactive.
4. Enforces the per-key rate limit (token bucket, in-memory) and
   rejects with `429` when the bucket is empty.
5. Touches `lastUsedAt` asynchronously (does not block the request).
6. Attaches `req.apiKey: { id, tenantId, name, scope, rateLimitPerMinute }`
   for downstream handlers / audit logging.

Verification is cached in-process for 30 s to avoid hammering Postgres
on the hot path. Negative results (unknown / revoked) are cached for 5 s
so an attacker can't replay-spam Postgres looking up bogus tokens.

## Enabling enforcement

Default is **open** so a fresh clone can run the curl examples in
`README.md`. Production deployments should set:

```env
RDA_REQUIRE_API_KEY=true
RDA_ADMIN_TOKEN=<long-random-string>
```

Without `RDA_REQUIRE_API_KEY=true`, `/v1/predict` accepts unauthenticated
requests; with it, missing/invalid keys return 401.

Without `RDA_ADMIN_TOKEN`, the entire `/v1/admin/*` surface returns
`503 Service Unavailable` — the admin API simply does not work until you
set the token. This is the safe default.

## Rate limiting

Token bucket per `apiKey.id`. Capacity = `rateLimitPerMinute`, refill
rate = capacity / 60_000 ms. In-memory, so each RDA replica has its own
bucket — three replicas with `rateLimitPerMinute=600` effectively allow
up to 1800 r/min per key in aggregate. If that matters to you, front
the bucket with Redis (the interface in `src/shared/auth/rate-limiter.ts`
is intentionally narrow to make that swap small).

## Revoking a key

```bash
curl -X DELETE http://localhost:3000/v1/admin/api-keys/<id> \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "suspected compromise" }'
```

Revocation clears the entire verify-cache, so the next request with
that token returns 401 within milliseconds.

## Listing keys

```bash
curl http://localhost:3000/v1/admin/api-keys \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN"
```

Returns metadata only — never the token or hash.

## Operational notes

- **Logging**: log `keyPrefix`, never the token. The prefix is enough
  to correlate suspicious traffic to a key without leaking it.
- **Rotation**: issue a new key first, swap clients to it, then revoke
  the old one. Tokens never expire automatically unless `expiresAt`
  was set at issue time.
- **Compromise**: rotate the admin token (env var + restart) and
  revoke every issued key. There's no central kill switch — keys are
  individually revoked.
