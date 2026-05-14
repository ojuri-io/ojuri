# API-key Authentication

This document describes the **API-key** model used by `/v1/predict`
(and other key-gated routes) and the per-key rate limit. For
**user-based login**, roles, and admin-API permission checks see
[`AUTHZ.md`](AUTHZ.md).

## Threat model

The platform is designed to be **self-hosted** by the adopting company.
Auth covers two distinct surfaces:

- **`/v1/predict` and read-only audit endpoints** — accessed by
  application code embedded in the adopter's payment flow.
  Authenticated with a long-lived API key (this doc).
- **`/v1/admin/*`** — operator endpoints (issue keys, register models,
  edit rules, manage users). Gated by user login + role-based
  permissions. See [`AUTHZ.md`](AUTHZ.md).

The earlier `RDA_ADMIN_TOKEN` / `X-Admin-Token` mechanism has been
**retired**. Operators authenticate as users (seeded admin:
`admin / admin@fraudit`) and the role's permission set determines
which admin routes they can hit.

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

Requires the `api_keys:issue` permission. Log in first to get a JWT
(see [`AUTHZ.md`](AUTHZ.md)):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"admin@fraudit"}' | jq -r .data.token)

curl -X POST http://localhost:3000/v1/admin/api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
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

Default is **open** for `/v1/predict` so a fresh clone can run the
curl examples in `README.md`. Production deployments should set:

```env
RDA_REQUIRE_API_KEY=true
AUTH_JWT_SECRET=<≥16-character random string>
```

Without `RDA_REQUIRE_API_KEY=true`, `/v1/predict` accepts
unauthenticated requests; with it, missing/invalid keys return 401.

The admin API is **always** gated by login + role permissions (no
"open" mode). Logging in to `POST /v1/auth/login` fails with
`503 Service Unavailable` until `AUTH_JWT_SECRET` is set.

## Rate limiting

Token bucket per `apiKey.id`. Capacity = `rateLimitPerMinute`, refill
rate = capacity / 60_000 ms. In-memory, so each RDA replica has its own
bucket — three replicas with `rateLimitPerMinute=600` effectively allow
up to 1800 r/min per key in aggregate. If that matters to you, front
the bucket with Redis (the interface in `src/shared/auth/rate-limiter.ts`
is intentionally narrow to make that swap small).

## Revoking a key

Requires `api_keys:revoke`.

```bash
curl -X DELETE http://localhost:3000/v1/admin/api-keys/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "suspected compromise" }'
```

Revocation clears the entire verify-cache, so the next request with
that token returns 401 within milliseconds.

## Listing keys

Requires `api_keys:read`.

```bash
curl http://localhost:3000/v1/admin/api-keys \
  -H "Authorization: Bearer $TOKEN"
```

Returns metadata only — never the token or hash.

## Operational notes

- **Logging**: log `keyPrefix`, never the token. The prefix is enough
  to correlate suspicious traffic to a key without leaking it.
- **Rotation**: issue a new key first, swap clients to it, then revoke
  the old one. Tokens never expire automatically unless `expiresAt`
  was set at issue time.
- **Compromise**: rotate `AUTH_JWT_SECRET` (invalidates every active
  login session on restart) and revoke every issued API key. There's
  no central kill switch — keys are individually revoked.
