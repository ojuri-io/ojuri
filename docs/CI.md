# Continuous integration

GitHub Actions configuration lives in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It runs on
every push to `main` and on every PR targeting `main`.

## Jobs

| Job | What it checks | Typical duration |
|---|---|---|
| `root · lint + test + build` | RDA: ESLint, Jest, `tsc`, `npm audit` | ~45 s |
| `paa-service · lint + test + build` | PAA: same matrix | ~25 s |
| `frontend · lint + test + build` | Sentinel: Vitest + Vite build | ~25 s |
| `python syntax check` | `py_compile` on every `.py` under `mla-service/src/` and `fia-service/src/` | ~5 s |
| `docker stack build + smoke` | `docker compose build` + `up -d` + boot the full stack + run end-to-end assertions through NGINX | ~3.5 min |

The first three run in a matrix and parallelise. The Docker job is
sequential by nature (it builds and boots the stack).

## What the smoke covers

The smoke step in `docker stack build + smoke` is the regression
gate. It asserts:

1. `docker compose build` succeeds for all images (catches Dockerfile
   breaks).
2. `docker compose up -d` brings every container to `healthy` —
   catches dependency-startup races (the kind of thing
   `condition: service_healthy` on `depends_on` fixes).
3. NGINX responds 200 on `/health` within 90 s of `up -d` — catches
   nginx-config breaks (e.g. an `upstream` block whose hostname
   doesn't resolve at startup).
4. `npm run db:migrate` runs cleanly **and** prints the one-time
   seed-password banner — catches a migration that silently breaks
   the random-password contract.
5. `POST /v1/predict` returns `decision_source: "ML"` with a
   populated `audit_id` — catches a model-load regression OR an
   audit-table write regression in one assertion.
6. `POST /v1/auth/login` with `admin / admin@fraudit` returns **401** —
   catches a regression of the hard-coded-default-password fix.
7. `GET /v1/audit-trails` unauth returns **401** — catches a
   regression of the audit-trail route auth-gate fix.
8. CORS does not reflect `https://evil.example` — catches a
   regression of the CORS allowlist fix.

If any step fails the `Dump logs on failure` step prints the last
60 lines of every container's stdout so the failure is diagnosable
from the run page without re-running locally.

## Required status checks (branch protection)

Recommended setup on `main`:

1. **Settings → Branches → Add branch protection rule** for `main`.
2. Enable **Require a pull request before merging**.
3. Enable **Require status checks to pass before merging**, plus
   **Require branches to be up to date before merging**.
4. In the status-check picker, add:
   - `root · lint + test + build`
   - `paa-service · lint + test + build`
   - `frontend · lint + test + build`
   - `python syntax check`
   - `docker stack build + smoke`
5. (Optional) **Do not allow bypassing the above settings** so even
   admin merges run through CI.

**Ordering**: status checks only appear in the picker once the
workflow has run at least once on the repository. Merge the CI
workflow PR first, let it run on `main`, then come back and add the
protection rule.

## Local mirror

The exact smoke sequence the Docker job runs can be reproduced
locally:

```bash
# from the repo root
cp .env.example .env
docker compose build
docker compose up -d
until curl -sf -m 2 http://localhost/health >/dev/null; do sleep 2; done
npm ci && npm run db:migrate    # confirm the seed banner prints
curl -sS -X POST http://localhost/v1/predict \
  -H 'Content-Type: application/json' \
  -d '{"transaction_id":"550e8400-e29b-41d4-a716-446655440000","sender_id":"u","receiver_id":"v","amount":1500.00,"transaction_type":"TRANSFER","timestamp":1717718400000}'
docker compose down -v
```

If those steps pass locally, the CI job will pass too (modulo
runner-vs-laptop variance — the GitHub `ubuntu-latest` runner has
4 GB / 4 vCPU spare for the stack).

## Why these checks specifically

The Docker smoke catches a class of bugs that unit tests cannot
see: dependency-startup races, env-var substitution failures,
nginx upstream resolution, and ordering bugs between migrations
and the running services. Two regressions on the
`pre-launch-fixes` branch (a `NODE_ENV=production` crashloop and
an nginx hard-fail on a missing FIA upstream) shipped to a green
test suite — they would have died at this job.
