# Users, Roles, and Permissions

Sentinel ships with a user-based login flow and a role/permission
model. Every `/v1/admin/*` route — and the `/v1/auth/me` endpoint — is
gated behind the new `requireAuth(...)` middleware. The `/v1/predict`
endpoint is **not** gated by user auth; it continues to use API keys
(see [`AUTH.md`](AUTH.md)).

> **Breaking change** — the static `RDA_ADMIN_TOKEN` /
> `X-Admin-Token` mechanism has been retired. Log in instead.

## Seed credentials

On first migration the platform seeds:

| Role            | Permissions                            | Purpose                                                   |
|-----------------|----------------------------------------|-----------------------------------------------------------|
| `SUPER_ADMIN`   | `["*"]` (all)                          | Full access. Cannot be deleted; permissions are immutable.|
| `FRAUD_ANALYST` | read + review-queue override + reports | Day-to-day analyst.                                       |
| `OPERATIONS`    | rules + models + api-keys + webhooks   | Platform operator. Cannot manage users.                   |

| Username | Password         | Roles         |
|----------|------------------|---------------|
| `admin`  | `admin@fraudit`  | `SUPER_ADMIN` |

**Change the seeded password before exposing the API to the network.**
Use `PATCH /v1/admin/users/:id` with `{ "password": "…" }`.

## Required env

```env
AUTH_JWT_SECRET=<≥16-character random string>
AUTH_JWT_TTL_SECONDS=28800             # optional; default 8 h
```

Login fails with `503 Service Unavailable` until `AUTH_JWT_SECRET` is
set to a non-empty value of at least 16 characters. Treat it like any
other production secret — rotating it invalidates all outstanding
sessions immediately.

## Login flow

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"admin@fraudit"}'
```

Response (`200`):

```json
{
  "status": true,
  "message": "Logged in",
  "data": {
    "token": "eyJhbGciOi…",
    "expiresAt": "2026-05-14T18:30:00.000Z",
    "user": {
      "id": "…",
      "username": "admin",
      "fullName": "Default Admin",
      "tenantId": "default",
      "roles": [{ "id": "…", "name": "SUPER_ADMIN" }],
      "permissions": ["*"]
    }
  }
}
```

Use the token on every subsequent admin call:

```bash
curl http://localhost:3000/v1/admin/users \
  -H "authorization: Bearer eyJhbGciOi…"
```

Inspect the current session:

```bash
curl http://localhost:3000/v1/auth/me -H "authorization: Bearer …"
```

`POST /v1/auth/logout` is a no-op on the server side (JWTs are
stateless); clients should discard the token.

## Permission catalogue

Lives in code at `src/shared/authz/permissions.ts`. The full list is
also served at `GET /v1/admin/permissions` so a UI role editor can
build the picker dynamically:

```bash
curl http://localhost:3000/v1/admin/permissions \
  -H "authorization: Bearer …"
```

Format: `<resource>:<action>`.

| Group        | Codes                                                                 |
|--------------|-----------------------------------------------------------------------|
| Users        | `users:read`, `users:create`, `users:update`, `users:delete`           |
| Roles        | `roles:read`, `roles:create`, `roles:update`, `roles:delete`           |
| API keys     | `api_keys:read`, `api_keys:issue`, `api_keys:revoke`                   |
| Webhooks     | `webhooks:read`, `webhooks:create`, `webhooks:delete`                  |
| Rules        | `rules:read`, `rules:create`, `rules:update`, `rules:delete`           |
| Models       | `models:read`, `models:register`, `models:set_status`, `models:set_threshold` |
| Audit log    | `audit:read`                                                          |
| Review queue | `review_queue:read`, `review_queue:override`                          |
| Reports      | `reports:read`, `reports:request`, `reports:message`                  |
| Metrics      | `metrics:read`                                                        |

The wildcard `*` is reserved for the `SUPER_ADMIN` role. It can't be
assigned to a custom role — the server rejects the request with `409`.

## Managing users

```bash
# Create a new user with one or more roles assigned at creation time.
curl -X POST http://localhost:3000/v1/admin/users \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{
    "username": "ayo",
    "password": "a-strong-passphrase",
    "fullName": "Ayo A.",
    "email": "ayo@example.com",
    "roleIds": ["<FRAUD_ANALYST id from GET /v1/admin/roles>"]
  }'

# Disable a user (audit trails remain attributable).
curl -X PATCH http://localhost:3000/v1/admin/users/<id> \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{ "isActive": false, "disabledReason": "Left the company" }'

# Reset password (admin-driven; the user does not need to be present).
curl -X PATCH http://localhost:3000/v1/admin/users/<id> \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{ "password": "new-strong-passphrase" }'

# Hard delete.
curl -X DELETE http://localhost:3000/v1/admin/users/<id> \
  -H "authorization: Bearer …"

# Assign / un-assign a role on an existing user.
curl -X POST http://localhost:3000/v1/admin/users/<id>/roles \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{ "roleId": "<role id>" }'

curl -X DELETE http://localhost:3000/v1/admin/users/<id>/roles/<roleId> \
  -H "authorization: Bearer …"
```

Guards:

- You cannot delete your own account.
- A user must keep at least one role — un-assigning the last role
  returns `409`.

## Managing roles

```bash
# Custom role: pick any subset of catalogue permissions.
curl -X POST http://localhost:3000/v1/admin/roles \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{
    "name": "MODEL_REVIEWER",
    "description": "Can register and promote models, no user mgmt",
    "permissions": [
      "models:read", "models:register", "models:set_status",
      "audit:read", "metrics:read"
    ]
  }'

# Edit permissions on a custom role (server hot-reloads on the next
# login — see "Permission changes don't take effect mid-session" below).
curl -X PATCH http://localhost:3000/v1/admin/roles/<id> \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{ "permissions": ["models:read", "metrics:read"] }'

# Delete a custom role.
curl -X DELETE http://localhost:3000/v1/admin/roles/<id> \
  -H "authorization: Bearer …"
```

Guards:

- The three system roles (`SUPER_ADMIN`, `FRAUD_ANALYST`,
  `OPERATIONS`) cannot be renamed or deleted.
- `SUPER_ADMIN.permissions` is permanently pinned to `["*"]`; the
  server refuses to edit it.
- A role must grant at least one permission; sending `[]` returns
  `409`.

## Permission changes don't take effect mid-session

The JWT carries a snapshot of the user's merged permissions at the
moment of login. Changing a role's permissions, assigning a new role,
or removing a role only affects the user on their **next login**. If
you need immediate revocation:

1. Disable the user (`PATCH /v1/admin/users/:id { isActive: false }`)
   — the next request rejects with `401` because the JWT verifier
   currently doesn't re-check the user row, but a quick follow-up
   commit can add that check by replacing `verifyToken` with a
   DB-backed check on the auth-sensitive routes.

The shorter `AUTH_JWT_TTL_SECONDS` is set, the tighter that window;
defaults to 8 hours.

## Error matrix

| Code | When                                                              |
|------|-------------------------------------------------------------------|
| 200  | Success                                                           |
| 201  | Resource created (user, role)                                     |
| 401  | Missing / malformed / expired JWT, bad password, unknown user     |
| 403  | Authenticated but missing the required permission code            |
| 404  | User or role id not found                                         |
| 409  | Username/role-name conflict, system role mutation, last role gone |
| 503  | `AUTH_JWT_SECRET` not configured                                  |

## Implementation notes

- Passwords are hashed with bcrypt (cost 10). Plaintext never reaches
  the database.
- The role row stores permissions as `text[]` (Postgres array). The
  permission catalogue is **code-defined** in
  `src/shared/authz/permissions.ts`; adding a new permission is a
  one-line change there + referencing it in a route's
  `requireAuth(...)` call. No migration required.
- Multi-tenancy: users, roles, and the unique-username/unique-role-name
  constraints are scoped by `tenantId` (defaults to `"default"`). Pass
  an explicit `tenantId` on create if you need isolation.
- The seeded admin user lives in the `default` tenant. Migrations are
  idempotent: running them twice does not re-seed.
