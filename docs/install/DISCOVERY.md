# Discovery notes: `ojuri up`, config manifest, client SDK

Phase 1 of the one-command-install work. Read-only. Every claim below
was checked against this checkout at `606377e` (v1.6.0). Where the
implementation guide and the checkout disagree, the checkout wins and
the difference is recorded under **Deviation**.

Conventions: file references are `path:line`. "The guide" means the
implementation guide this branch is working from.

---

## 0. Branch and base

**Deviation (process).** The guide asks for `feat/one-command-install`
off `develop`. There is no `develop` branch on this remote: `git
ls-remote --heads origin` returns `main` plus topic branches only. The
session is also pinned by its harness to the branch
`claude/ojuri-one-command-install-pjtq7v`, created off `main`. Work
proceeds on that branch, based on `main`. No design impact.

---

## 1. Services, profiles, ports, volumes, networks

### Compose services (`docker-compose.yml`)

| Service | Line | Profile | Published ports | Notes |
|---|---|---|---|---|
| `nginx` | 5 | none | `80:80` | Only ingress in the default stack. |
| `sentinel` | 33 | `sentinel` | **none** | Behind nginx only. No host port. |
| `rda` | 54 | none | **none** | `deploy.replicas: ${RDA_REPLICAS:-3}` at 124. |
| `paa-1` | 142 | none | `9091:9090` | `deploy.replicas: 1` hard-coded at 184. |
| `fia` | 194 | `fia` | `9094:9094` | `mem_limit: 16g` at 267. |
| `mla` | 288 | `mla` | `9095:9095` | |
| `redis` | 328 | none | `6380:6379` | |
| `zookeeper` | 347 | none | none | |
| `kafka` | 359 | none | `9092:9092`, `29092:29092` | |
| `postgres` | 392 | none | `5433:5432` | |
| `db-migrate` | 422 | none | none | One-shot, `restart: "no"`. |
| `demo-seed` | 480 | `demo` | none | One-shot. |
| `prometheus` | 503 | none | `9090:9090` | No profile: always started. |
| `grafana` | 518 | none | `3001:3000` | No profile: always started. |

Network: `ojuri-network`, bridge (`docker-compose.yml:536`). Confirmed.

Volumes (`docker-compose.yml:543`): `redis-data`, `postgres-data`,
`kafka-data`, `zookeeper-data`, `zookeeper-logs`, `prometheus-data`,
`grafana-data`, `fia-hf-cache`, `mla-data`.

Profiles in the base file: `sentinel` (34), `fia` (200), `mla` (289),
`demo` (481). Four, as the guide says.

### Deviations from the guide's service list

- **`paa`, not `paa-1`.** The service is `paa-1`
  (`docker-compose.yml:142`), and the ghcr overlay keys off that name
  (`docker-compose.ghcr.yml:28`). The manifest key can stay `paa` for
  readability, but every rendered override and every `docker compose`
  argument must say `paa-1`.
- **Port `3001` is Grafana, not Sentinel** (`docker-compose.yml:521`).
  The guide's `network.sentinel_port: 3001` would collide. Sentinel
  publishes no host port at all in the shipped stack.
- **Port `3000` is not published by the prod stack.** Only
  `docker-compose.dev.yml:55` publishes `3000:3000`, for `rda-dev`.
- **Port `9093` is published by nothing.** `grep -rn 9093` over
  compose, nginx, `src/`, and the Python services returns no hit. The
  README's port list (`README.md:184`) is stale on this point.
- **Prometheus and Grafana have no profile.** They start on a plain
  `docker compose up`. Making `observability.enabled: false` work means
  the render step must *remove* them, not just withhold a profile.

### `docker-compose.ghcr.yml` diff

The overlay changes exactly one thing per service: it drops the
`build:` block with `!reset null` and sets `image:
ghcr.io/ojuri-io/<name>:${OJURI_VERSION:-v1}`. Six services are
covered: `rda`, `paa-1`, `db-migrate`, `fia`, `mla`, `sentinel`
(lines 24 to 46). Note `db-migrate` reuses the `rda` image (line 34).
Nothing else differs: no env, port, volume, or replica change. The
overlay requires Compose 2.24+ for `!reset` (documented at
`docker-compose.ghcr.yml:18`, matching the README's stated minimum).

---

## 2. Environment variables per service

Source: the `environment:` blocks in `docker-compose.yml`, plus
`.env.example`.

### Values compose reads from `.env` (the manifest's real surface)

`OJURI_VERSION`, `NODE_ENV`, `RDA_REPLICAS`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`,
`AUTH_JWT_SECRET`, `AUTH_JWT_TTL_SECONDS`, `AUTH_JWT_ISSUER`,
`AUTH_JWT_AUDIENCE`, `RDA_REQUIRE_API_KEY`, `SENTINEL_CORS_ORIGINS`,
`MLA_SERVICE_TOKEN`, `AUDIT_PIPELINE`, `PAA_HEALTH_URL`,
`FIA_HEALTH_URL`, `MLA_HEALTH_URL`, `ADMIN_SEED_PASSWORD`,
`SEED_DEMO_RULES_ACTIVE`, `SEED_DEMO_USER`, `DEMO_USER_PASSWORD`,
`DEMO_CREDENTIALS_URL`, `DEMO_API_KEY`, `DEMO_TX_COUNT`,
`GRAFANA_USER`, `GRAFANA_PASSWORD`, the `FIA_*` block, `MLA_LOG_LEVEL`,
`DRIFT_PSI_THRESHOLD`, `DRIFT_F1_THRESHOLD`.

### Hostnames hardcoded in the compose file, not passed in

These are the reason `mode: external` needs a compose overlay rather
than an `.env` change. Every one is a literal in `docker-compose.yml`:

- `REDIS_HOST=redis` (RDA 62, PAA 151), `REDIS_PORT=6379`.
- `KAFKA_BROKERS=kafka:29092` (RDA 70, PAA 158, FIA 210, MLA 299).
- `DB_HOST=postgres`, `DB_PORT=5432` (RDA 97, db-migrate 440).
- `DB_URL=postgresql://...@postgres:5432/...` (RDA 79, PAA 164).
- `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432` (FIA 214, MLA 294).

So the `.env` values `DB_HOST`, `REDIS_HOST`, `KAFKA_BROKERS` and
friends (`.env.example:36,53,63`) are consumed only by host-side runs
(`npm run start:dev`, the knex CLI, host-side MLA/FIA), **never** by
the containers. Any external-datastore support must override these in
the compose overlay per service. Recording this because it is the
single biggest structural finding for Phase 3.

### Gaps in `.env.example`

Referenced by `docker-compose.yml` but absent from `.env.example`:
`ADMIN_SEED_PASSWORD` (compose 454), `DEMO_API_KEY` (486),
`DEMO_TX_COUNT` (487), `MLA_LOG_LEVEL` (304), `PAA_HEALTH_URL` /
`FIA_HEALTH_URL` / `MLA_HEALTH_URL` (86 to 88, present in
`.env.example` only as commented host-side examples at 108 to 110).
`ALLOW_UNSAFE_PROD_DEFAULTS` (`src/server.ts:100`) is in neither.

---

## 3. Migrations and `db-migrate`

`db-migrate` (`docker-compose.yml:422`) runs, in one shell:

```
knex --knexfile knexfile.js migrate:latest && knex ... seed:run
```

against `/app/dist/database/{migrations,seeds}`
(`KNEX_MIGRATIONS_DIR` / `KNEX_SEEDS_DIR`, lines 445 to 446). It
mounts `./models:/app/models:ro` (464) because the
`00_initial_model_version` seed reads the ONNX file. It depends only on
`postgres` being healthy (466), not on Kafka or Redis.

### The admin password is seeded by a MIGRATION, not a seed

`src/database/migrations/20260514000001_create_users_roles_tables.ts`.
`resolveSeedPassword()` at line 131: uses `ADMIN_SEED_PASSWORD` when
set and at least 12 chars; **throws** when set but shorter (line 137);
otherwise generates 18 random bytes as base64url and prints a banner
via `printSeedPasswordBanner()` (line 145) using `console.log`, because
knex's logger swallows migration stdout.

**This is load-bearing for the manifest.** Because the admin user is
created inside `up()` of a migration, it happens **once per database**.
Setting `ADMIN_SEED_PASSWORD` has no effect on a database where that
migration has already run. Consequences:

- `ojuri init` generating `ADMIN_SEED_PASSWORD` only helps on a **fresh
  volume**. On an existing stack the value is inert and `ojuri up` must
  not claim otherwise.
- Against an **external Postgres that already has the schema**,
  `migrate:latest` is a safe no-op ("Already up to date") and
  `seed:run` re-runs the seeds, which are written idempotently. But no
  admin is created and no password is printed. The recovery path is
  `npm run reset:admin` (`package.json:44`,
  `scripts/reset-admin-password.ts`).

Safety against an external Postgres that already has the schema: yes
for `migrate:latest`. `seed:run` re-runs all six seeds
(`src/database/seeds/`) on every `up`; the README and compose comment
(line 418) both treat this as expected. It is still a write against the
adopter's database, which is why section 9 asks whether it should be
gated.

---

## 4. Sentinel

Confirmed: the `sentinel` compose service exists
(`docker-compose.yml:33`), built from `./frontend/Dockerfile`, gated
behind `profiles: ["sentinel"]`, published to GHCR as
`ghcr.io/ojuri-io/sentinel` (`docker-compose.ghcr.yml:44`).

### The SPA is same-origin only, and needs no backend URL

`frontend/src/api/client.js` issues **relative** paths exclusively:
`fetch('/v1/auth/login')` (77), `fetch('/v1/predict')` (199),
`fetch('/v1/admin/api-keys')` (217), and so on. There is no base-URL
constant and no `VITE_*` read anywhere in the client. The production
image (`frontend/Dockerfile`) is a static bundle behind a bare nginx
that only does SPA history fallback: no proxy, no runtime config, no
build arg for an API URL.

So in a same-origin deployment Sentinel needs **no** backend URL, and
**no** CORS entry either. `frontend/.env` (`frontend/.env.example`) is
purely for the Vite dev server's proxy targets (`VITE_RDA_URL`,
`VITE_FIA_URL`, `VITE_MLA_URL`, consumed at
`frontend/vite.config.js:32` to `34`); the comment at the top of
`.env.example` states these "are read at vite startup and never reach
the browser bundle".

### The real gap: nginx does not route to Sentinel

**Deviation, design-relevant.** The guide states that in the shipped
stack nginx routes `/` to the `sentinel` container when the profile is
on. It does not. `nginx/nginx.conf:183` routes `location /` to
`http://rda_backend`. The only config that fronts Sentinel is
`deploy/aws/nginx/nginx.conf:127`, which sets `$sentinel_upstream
sentinel` and proxies `/` to it. The compose comment at
`docker-compose.yml:27` to `32` says exactly this, and points at the
AWS file as the worked example.

Therefore `sentinel.enabled: true` alone starts a container that
nothing routes to. Making it useful needs one of: mounting a different
`nginx.conf` over `nginx`'s (the config is a bind mount at
`docker-compose.yml:10`, so an overlay can swap the source file), or
publishing a host port on the `sentinel` service. This is an installer
concern, not a Sentinel change, so it is in scope. Proposal for
Phase 3: ship a second nginx config alongside the existing one and have
the render step point the bind mount at it when `sentinel.enabled` is
true. Nothing about the default path changes.

### Stale README paragraphs

- `README.md:80` `git clone --depth 1 --branch v1.4.0` (current release
  is v1.6.0; `package.json:3` says `1.6.0`).
- `README.md:493` "**Stable as of v1.4.0.**"
- `README.md:314` to `320`: "It isn't wired into `docker-compose.yml`
  ... NGINX already holds port 80 there". The first half is now false
  (the service exists behind a profile); the second half is still true
  and is the actual reason it is not routed.
- `README.md:184` port list includes `9093`, which nothing uses.

### Nginx routes in the default config (`nginx/nginx.conf`)

`= /health` to RDA `/livez` (69), `= /ready` to RDA `/readyz` (75),
`/v1/predict` with the rate limit (82), `/v1/metrics` (112),
`/v1/admin/training/upload` (128), `/mla/` to
`host.docker.internal:9095` with a `rewrite` stripping the prefix
(151), `/fia/` to `fia:9094` likewise (166), `/` to RDA (183),
`/nginx_status` (190). Prefix stripping and per-request resolution via
`resolver 127.0.0.11` (56) confirmed as the guide describes.

Note `/mla/` points at `host.docker.internal` in the default config
(152) but at the in-compose `mla` service in the AWS one
(`deploy/aws/nginx/nginx.conf:104`). Enabling `mla` through the
manifest therefore also wants the `MLA_HEALTH_URL=http://mla:9095`
override that the compose comment at `docker-compose.yml:285` to `287`
describes, and ideally the nginx route too.

---

## 5. FIA when absent

`--profile fia` is the only mechanism (`docker-compose.yml:200`).
Nothing in the default stack waits on FIA:

- `rda` has no `depends_on` entry for it (`docker-compose.yml:111`).
- nginx defers FIA DNS to request time via the `$fia_upstream` variable
  (`nginx/nginx.conf:167`), specifically so it does not hard-fail at
  startup when FIA is not running. Callers get a 502, which the comment
  at line 126 calls correct.
- RDA readiness does not consult FIA: `readinessCheck`
  (`src/v1/modules/health/health.service.ts:62`) checks Postgres,
  Redis, and the ONNX model only.
- The Service Health page returns `UNKNOWN` rather than `DOWN` for a
  target with no URL configured
  (`src/v1/modules/health/health.service.ts:129` to `139`).

Sentinel's own degradation is the `safe()` wrapper documented in
`CLAUDE.md` and implemented across `frontend/src/api/client.js`: reads
fall back to empty values, so FIA pages render an empty state rather
than erroring. Confirmed by inspection of the `safe(...)` call sites
(for example line 169, 173, 211, 217).

---

## 6. MLA when absent

Same shape as FIA: `--profile mla` only (`docker-compose.yml:289`), no
`depends_on` from RDA, `/mla/` resolved per request
(`nginx/nginx.conf:152`).

`MLA_HEALTH_URL` defaults to `http://host.docker.internal:9095`
(`docker-compose.yml:88`) on the assumption MLA runs natively on the
host. Setting it to the empty string makes `buildServiceTargets()`
produce a target with no URL, which reports `UNKNOWN`
(`src/v1/modules/health/health.service.ts:129`). That is the documented
way to say "MLA is deliberately off" (compose comment, lines 83 to 85).

`MLA_SERVICE_TOKEN` is the MLA-to-RDA direction only: MLA presents it
to register model versions and flip them ACTIVE
(`.env.example:171` to `179`). With MLA absent nothing presents it and
nothing breaks. It ships with a **dev default value** in
`.env.example:179`, unlike `AUTH_JWT_SECRET` there is no boot-time
guard against that default in `src/server.ts`.

---

## 7. Kafka

Topics: `transactions.completed` (`docker-compose.yml:71`, 159, 300)
and `transactions.blocked` (72, 211). Consumer groups:
`pattern-analysis` (PAA, 160), `ojuri-investigation` (FIA, 212),
`mla-drift-monitor` (MLA, 301). Dev overrides use `paa-dev` and
`ojuri-investigation-dev` (`docker-compose.dev.yml:81,115`).

Broker config: `KAFKA_NUM_PARTITIONS: 12`,
`KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"`,
`KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1`
(`docker-compose.yml:373` to `375`). Topics are auto-created; nothing
provisions them explicitly.

Nothing assumes a **partition count**. `src/shared/kafka/` handles
partitions dynamically: `commitOffset(topic, partition, offset)`
(`kafka-consumer.ts:208`) and per-partition lag iteration (250 to 259).
What is assumed is **per-key ordering**: the producer keys
`transactions.completed` by `sender_id` for PAA's per-user ordering and
`transactions.blocked` by `transaction_id` so one hot sender does not
pin FIA to a single partition (`kafka-producer.ts:202` to `208`).
External Kafka must therefore provide at least one partition and honour
keyed ordering, which any Kafka does. No guard needed beyond a
reachability check.

---

## 8. Singletons

### PAA: confirmed singleton, must never scale

State lives in process memory. `graph.service.ts:50` constructs the
graph in the constructor:

```ts
this.graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: false });
```

and the module exports a process-wide instance at
`paa-service/src/services/graph.service.ts:519`
(`export const graphService = new GraphService();`). The compose file
carries a nine-line "DO NOT scale this service" comment
(`docker-compose.yml:131` to `141`) and pins `deploy.replicas: 1`
(184).

The fence exists as described: `LEASE_KEY = "ojuri:paa:leader"`
(`paa-service/src/services/leader-lease.service.ts:8`),
`requireLeaderLease: process.env.PAA_REQUIRE_LEADER_LEASE !== "false"`
(`paa-service/src/config/app.config.ts:37`), the disable warning at
`paa-service/src/worker.ts:372`, and the `paa_group_members` gauge
(`paa-service/src/utils/metrics.ts:80`).

**Verdict: `paa.replicas > 1` is a hard error.**

### MLA: also unsafe above one replica

MLA has **no** leader lease, lock, or lease key: grepping
`leader|lease|singleton|lock` across `mla-service/src/` returns only
the unrelated "singleton `mlaSettings` row" comments
(`mla-service/src/api/settings_repo.py:22,65`).

Its retrain guards are in-process instance attributes:

- `self.retraining_in_progress` checked at `mla-service/src/main.py:295`.
- `self._last_retrain_attempt_at` is the entire cooldown mechanism
  (`_cooldown_blocks`, `mla-service/src/main.py:299` to `317`, set at
  line 354).

Two replicas each keep their own copy, so both can pass the cooldown
and start a retrain in the same window. They would then both write into
the same bind-mounted `./models` volume
(`docker-compose.yml:312`) and both register versions with RDA using
the shared `MLA_SERVICE_TOKEN`.

**Verdict: `mla.replicas > 1` is a hard error.** The guide left this
conditional on discovery; discovery says error.

### FIA: logically safe, blocked by the port mapping

FIA's only cross-message state is the poison-message retry counter
`self._retry_counts` (`fia-service/src/main.py:58`, mutated at 101, 123
to 128, reported at 160). Because Kafka assigns each partition to
exactly one consumer in a group, that counter is partition-local and
correct under fan-out. Writes are idempotent: `ON CONFLICT
("transactionId") DO NOTHING`
(`fia-service/src/persistence/report_writer.py:40`) and the same for
conversation turns (line 118). Offsets are committed per partition.

So multiple FIA replicas are **logically** sound. Two practical
blockers:

1. **Fixed host port.** `ports: - "9094:9094"`
   (`docker-compose.yml:250`) cannot be bound twice. Compose fails at
   the second replica. The render step must drop or randomise the
   published port when `fia.replicas > 1`.
2. **Memory.** `mem_limit: 16g` per container
   (`docker-compose.yml:267`) plus roughly 10 GB of disk for weights,
   though the `fia-hf-cache` volume is shared so the download happens
   once.

**Verdict: allow `fia.replicas > 1` with a warning covering both, and
handle the port in render.** The same fixed-port issue applies to
`paa-1` (`9091:9090`, line 170) and `mla` (`9095:9095`, line 310), but
both are capped at 1 anyway.

---

## 9. NGINX and replica resolution

`upstream rda_backend` names a single literal peer, `server rda:3000`
(`nginx/nginx.conf:49`). Docker's embedded DNS returns one A record per
replica; nginx expands them into separate peers **once, at startup**.
The comment at lines 41 to 44 says restart nginx after scaling so it
re-resolves. Confirmed, and it matches `.env.example:247` to `248`.

Two consequences:

- `ojuri up` must `restart nginx` after any change to `RDA_REPLICAS`,
  as the guide says.
- The same technique does **not** transfer to other services, because
  no other service is load-balanced by nginx. `/fia/` and `/mla/` use
  the `set $var` plus resolver form (`nginx/nginx.conf:167`, 152),
  which re-resolves per request with `valid=10s` (56) and so picks up
  replica changes on its own, but it resolves to a single address per
  request rather than balancing across peers.

---

## 10. Existing CLI-adjacent surface

### Scripts

`scripts/` holds `demo-traffic.mjs`, `seed-load.ts`, `replay.ts`,
`reset-admin-password.ts`, `fraud-sim.mjs`,
`fraud-typology-simulation.ts`, `fraud-validation-load-test.ts`, plus
Python analysis helpers. Relevant npm scripts (`package.json:26` to
`45`): `db:migrate`, `db:seed`, `seed:load`, `demo:load`, `replay`,
`reset:admin`.

`scripts/demo-traffic.mjs:1` to `5` already probes both
`http://localhost` and `http://localhost:3000` so neither layout needs
`RDA_URL` set. Good precedent for how `ojuri status` should find RDA.

### Package manager and layout

npm, Node 20 (`.nvmrc`). **No npm workspaces**: `grep workspaces
package.json` returns nothing, and the root `package.json` *is* the RDA
service. Each sub-project is a top-level directory with its own
`package.json` and `package-lock.json` (`paa-service/`, `frontend/`),
and CI models exactly that: `.github/workflows/ci.yml:27` to `42` is a
matrix of `{workspace, dir}` entries, each running `npm ci` with
`cache-dependency-path: ${{ matrix.dir }}/package-lock.json`
(line 49). `release.yml:88` mirrors it, with the same path at
line 100.

**So the convention is: a new package is a directory with its own
package.json plus a new CI matrix entry.** `packages/cli`,
`packages/client-ts` and `packages/client-py` fit that, with three
caveats found by inspection:

- `jest.config.js:13` already sets `moduleDirectories: ['node_modules',
  'packages']`, and `testPathIgnorePatterns` (line 24) does **not**
  exclude `packages/`. Root Jest would try to run the CLI's tests under
  the root ts-jest config. Add `/packages/` to that list.
- `.eslintignore` lists every sibling project by name
  (`paa-service`, `mla-service`, `fia-service`, `frontend`, `scripts`).
  Add `packages`.
- Root `tsconfig.json:include` is `["src/**/*.ts", ...]`, so `npm run
  build` will not pick up `packages/`. Nothing to change; each package
  brings its own tsconfig.

### `deploy/aws/` and the `ojuri-up` name

`deploy/aws/scripts/bootstrap.sh.tftpl:160` writes a **host shell
script** at `/usr/local/bin/ojuri-up`, `chmod 755` at line 178, invoked
by `ExecStart=/usr/local/bin/ojuri-up` in the `ojuri.service` systemd
unit (line 250). What it does (lines 162 to 176):

```
cd /opt/ojuri
ojuri-write-env                      # renders .env from SSM parameters
docker compose -f docker-compose.yml \
  -f docker-compose.ghcr.yml \
  -f deploy/aws/compose/docker-compose.ec2.yml \
  --profile mla --profile fia --profile sentinel up -d --remove-orphans
ojuri-invalidate-cdn "$(... ps -q sentinel ...)" || true
```

This is, in effect, a hand-rolled `ojuri up` for one deployment
target: render env, pick compose files, activate profiles, bring the
stack up. It is a strong argument that the CLI's shape is right.

On the naming clash: there is **no filename collision**. A CLI binary
named `ojuri` and a script named `ojuri-up` are different files and can
coexist on `PATH`. The clash is only that `ojuri up` and `ojuri-up`
would be two similarly-named commands doing overlapping-but-different
things on the same box. Options for section 9, in order of preference:

1. Keep `ojuri up`, and later rewrite the boot unit to call it
   (`ExecStart=/usr/local/bin/ojuri up`), deleting the bespoke script.
   Out of scope for this branch but the natural end state.
2. Keep both, rename the boot script to `ojuri-boot`. One-line change,
   but touches deployed infrastructure.
3. Name the CLI verb `ojuri start`. Cheapest, but `up` is the verb
   every adopter already knows from Compose.

Recommendation: option 1, with the rename deferred. Flagging for a
decision before Phase 4 as the guide requires.

---

## 11. Predict contract: source of truth

**There is no OpenAPI document in this repo.** `find src -iname
'*.yaml' -o -iname '*openapi*' -o -iname '*swagger*'` returns nothing.
(The root `postbuild` copies `src/**/*.yaml` into `dist`, so the build
anticipates YAML that does not currently exist.)

The de-facto sources are:

- `src/v1/modules/rda/dtos/predict-request.dto.ts`:
  `PredictRequestDto` (line 20), `ReasonCodeDto` (86),
  `PredictResponseDto` (96).
- `src/v1/modules/rda/validations/predict.validator.ts`: the actual
  runtime constraints, as validatorjs rule strings (line 4).
- `docs/PREDICT-API.md`: 333 lines, and the most complete description
  of the wire format, including headers, every error status, and a
  full-payload example.

Six required fields, confirmed against the validator (lines 11 to 21):
`transaction_id` (10 to 255 chars), `sender_id`, `receiver_id`,
`amount` (0.01 to 9999999999), `transaction_type` (five-value enum),
`timestamp` (0 to 9999999999999). The guide's "six required fields" is
right; the DTO's own doc comment calling them the "core 8"
(`predict-request.dto.ts:13`) is stale.

### Three discrepancies the spec generation must resolve

1. **`basis` is on the wire but missing from `ReasonCodeDto`.** The
   runtime `ReasonCode`
   (`src/shared/onnx/reason-codes.types.ts:13` to `19`) has
   `basis: ReasonBasis`, `explain()` populates it
   (`src/shared/onnx/reason-codes.ts:128`), the context types carry
   `ReasonCode[]` (`predict.types.ts:71,90,109`), and the factory
   passes them straight through
   (`predict-response.factory.ts:18`). But `ReasonCodeDto`
   (`predict-request.dto.ts:86` to `91`) declares only `code`,
   `description`, `contribution`, `value`. `docs/PREDICT-API.md:197`
   and `218` document `basis`. **Generating from the DTO alone would
   silently drop the field the guide explicitly wants exposed.** Fix
   the DTO as part of Phase 5.

2. **`request_context` is undeclared.** Documented at
   `docs/PREDICT-API.md:182` as adopter overflow, real on the Kafka
   event (`src/shared/kafka/kafka-producer.ts:97`), and read out of the
   request by a double cast in
   `src/v1/modules/rda/factories/transaction-event.factory.ts:58`
   (`(request as unknown as Record<string, unknown>).request_context`).
   It is in neither the DTO nor the validator.

3. **`/v1/predict` returns the bare DTO, not the `SuccessResponse`
   envelope.** `sendOutcome` sends `outcome.response` directly
   (`predict.controller.ts:227`), while every other route wraps in
   `{ status, message, data, meta }`
   (`src/shared/utils/response.util.ts:3`). Errors on `/v1/predict`
   *do* use the envelope, via `ErrorResponse`
   (`response.util.ts:12`). The SDKs must parse two different shapes on
   the same endpoint.

### Status codes, from `sendOutcome` (`predict.controller.ts:216` to `252`)

| Status | `outcome.kind` | Meaning |
|---|---|---|
| 200 | `ok` | Fresh prediction, `X-Response-Time` header. |
| 200 | `replay` | Idempotency replay, `Idempotency-Replay: true`. |
| 422 | `conflict` | Same Idempotency-Key, different body. |
| 409 | `in_flight` | Same Idempotency-Key still in flight, `Retry-After: 1`. |
| 409 | `duplicate` | `transaction_id` already processed for this tenant. |
| 400 | (pre-handler) | Validation failure, or Idempotency-Key over 128 chars. |
| 401 | (pre-handler) | Missing `X-Api-Key` when `RDA_REQUIRE_API_KEY=true`. |
| 503 | `AppError` | Audit-queue backpressure, `Retry-After: 1`. |

**Two distinct 409s.** They differ only in message text and in whether
`Retry-After` is present. The guide's single `DuplicateTransactionError`
mapping would conflate "you already scored this transaction, do not
retry" with "a concurrent request holds this key, retry in a second",
which are opposite instructions. Proposal for Phase 5: map 409 with
`Retry-After` to a retryable `ConcurrentRequestError` and 409 without
it to `DuplicateTransactionError`. Flagged rather than assumed.

`docs/PREDICT-API.md`'s error table (line 238) documents the in-flight
409 but **not** the duplicate 409. A doc gap to close in Phase 6.

Auth on the route: `apiKeyMiddleware({ required: requireApiKey })`
where `requireApiKey` is read from the environment at **module load**
(`src/v1/modules/rda/routes/predict.route.ts:10`), so it is fixed for
the process lifetime. Changing `RDA_REQUIRE_API_KEY` needs an RDA
restart, not just a config reload.

API keys are issued at `POST /v1/admin/api-keys` behind
`requireAuth("api_keys:issue")`
(`src/v1/modules/admin/routes/api-keys.route.ts:21` to `28`).
Confirmed available for the `up` flow.

---

## 12. Gaps: things the later phases need that do not exist

1. **No OpenAPI document.** Phase 5 must generate
   `docs/openapi/predict.v1.yaml` from the DTOs plus the validator,
   after fixing the three discrepancies in section 11. The validator,
   not the DTO, holds the numeric and length constraints, so generation
   has to read both.
2. **No `packages/` directory and no workspace machinery.** Adding one
   means new CI matrix entries plus the three ignore-list edits in
   section 10.
3. **External datastores are not expressible today.** Every datastore
   hostname is a literal in `docker-compose.yml` (section 2), so
   `mode: external` requires per-service environment overrides in the
   rendered overlay, not merely different `.env` values.
4. **Prometheus and Grafana cannot be switched off** without removing
   the services; they carry no profile.
5. **Sentinel has no route in the default nginx config** (section 4),
   so `sentinel.enabled` needs an nginx config swap to be more than a
   started container.
6. **`ADMIN_SEED_PASSWORD` is not in `.env.example`** and is inert
   after the first migration run (section 3).
7. **No health check exists for "is the stack up"** beyond nginx
   `/ready`. That is sufficient: RDA readiness covers Postgres, Redis
   and the model, and is not blocked by FIA or MLA (section 5).
8. **`db-migrate` has no completion signal other than exit status.**
   `ojuri up` must wait on the container exiting 0 rather than polling
   an endpoint.

---

## Extra finding: the production boot guard is wider than the guide assumes

`src/server.ts:95` `warnIfUnsafeDefaults()` collects **three**
violations, not one:

- `RDA_REQUIRE_API_KEY` false (line 114).
- `AUTH_JWT_SECRET` starting with `dev-only-secret` or shorter than 32
  chars (line 116).
- `SENTINEL_CORS_ORIGINS` empty or containing `localhost` (line 123).

With `NODE_ENV=production` and any violation present, RDA logs and
calls `process.exit(1)` (line 138) unless
`ALLOW_UNSAFE_PROD_DEFAULTS=true` (line 100).

**Deviation, design-relevant.** The guide's validate rule keys the JWT
check on "`release` is not a dev value". `release` maps to
`OJURI_VERSION`, which is only an image tag and has no bearing on
`NODE_ENV`. The rule that actually mirrors RDA's behaviour is keyed on
`NODE_ENV=production`, and it should cover all three violations plus
recognise the `ALLOW_UNSAFE_PROD_DEFAULTS` escape hatch. Proposed for
Phase 2:

- `NODE_ENV=production` and any of the three violations, without
  `ALLOW_UNSAFE_PROD_DEFAULTS=true`: hard error, quoting RDA's own
  message so the operator sees the same words twice.
- Otherwise: warnings, matching RDA's own dev-mode behaviour.

This is the same intent as the guide's rule, mapped onto what the code
actually does, so it is recorded here and applied rather than escalated.

Docker and Compose minimums for `ojuri doctor`, from `README.md:74`:
**Docker 20.10+ and Compose 2.24+**. The 2.24 floor is real, not
advisory: `docker-compose.ghcr.yml` needs `!reset`.

---

## Addendum: Compose merge behaviour, verified by probe

Established after the notes above were first written, while checking
what this environment could actually run. `docker compose config`
resolves, merges and validates a project **without a Docker daemon**, so
every claim here was checked against the real Compose binary (v5.1.1)
rather than reasoned about. The daemon itself is unavailable in this
environment, so nothing below involves starting a container.

### Dropping a bundled datastore needs `!override` on `depends_on`, not only `!reset`

`!reset null` does remove a service, but the merged project then fails
validation, because the services that depended on it still name it:

```
$ docker compose -f docker-compose.yml -f drop-postgres.yml config
service "rda" depends on undefined service "postgres": invalid compose project
```

`rda`, `paa-1`, `db-migrate`, `fia` and `mla` all declare
`depends_on: postgres` (section 2). Compose's `!override` replaces a
mapping wholesale rather than merging into it, so the fix is to restate
each dependant's **surviving** edges:

```yaml
services:
  postgres: !reset null
  db-migrate:
    depends_on: !override {}
  rda:
    depends_on: !override
      redis: { condition: service_healthy }
      kafka: { condition: service_healthy }
      db-migrate: { condition: service_completed_successfully }
```

Verified: that overlay yields a nine-service project with no `postgres`,
`db-migrate` retained, and `DB_HOST` pointing at the external host.

This is why `packages/cli/src/render/compose-base.ts` carries a
`BASE_DEPENDS_ON` table, and why `test/compose-base.spec.ts` pins it
against the real compose file: a new `depends_on` edge added to
`docker-compose.yml` without updating the table would render a project
Compose refuses.

### Other merge facts the renderer relies on

| Behaviour | Result |
|---|---|
| `services: {}` as a whole overlay | Accepted. The no-op overlay parses and changes nothing. |
| An overlay of comments only, no `services` key | Also accepted. |
| `ports: !reset null` | Removes the published ports. This is how a scaled FIA gives up its fixed `9094:9094`. |
| `volumes: !override [...]` on `nginx` | Replaces the config bind mount cleanly, leaving one mount rather than two conflicting ones at the same target. |
| `environment:` map form overriding the base file's list form | Merges per key. `DB_HOST` can be overridden while `DB_PASSWORD` from the base file survives. |
| Repeated `--env-file` | Last wins. `--env-file .env --env-file .ojuri/.env.rendered` lets the rendered file override only the fields the manifest controls. |

### The default manifest renders to a genuine no-op

Confirmed by byte-comparing the resolved configs, not by inspection:

```
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml config
```

against the same command with `--env-file .ojuri/.env.rendered` and
`-f .ojuri/docker-compose.override.ojuri.yml` added. The two outputs are
identical, 367 lines each. `.github/workflows/ci.yml` runs this
comparison so it stays true.

### What this environment cannot check

There is no Docker daemon and no `nginx` binary, so nothing here has
been started and `nginx/nginx.sentinel.conf` has not been through
`nginx -t`. The nginx service's own compose healthcheck is `nginx -t`,
so a syntax error would surface the first time the `sentinel` profile is
started. `packages/cli/test/nginx-sentinel.spec.ts` checks the file
structurally in the meantime: brace balance, every route the default
config serves, and byte-identity with `nginx/nginx.conf` up to the
routing change.
