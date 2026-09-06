# `@ojuri/cli`

The `ojuri` command. Reads the deployment manifest at `ojuri.yaml` and,
in later phases, renders it into a `.env` fragment and a Docker Compose
overlay and drives the stack.

Seven commands: `init`, `doctor`, `up`, `status`, `down`, plus the
`validate` and `render` they are built on.

## Install

Not published yet. From a checkout:

```bash
cd packages/cli
npm install
npm run build
node dist/index.js validate ../../ojuri.yaml
```

## `ojuri validate [path]`

Checks a manifest and says what is wrong with it. With no path it reads
`./ojuri.yaml`.

```bash
ojuri validate                  # human-readable
ojuri validate --json           # machine-readable, for CI
```

Exit code is 0 when the manifest is usable and 1 when it is not.
Warnings are printed but never change the exit code, so a fresh
checkout, which has three of them, still passes.

Two layers run in order. The JSON Schema in `schema/ojuri.v1.json`
decides whether the file is well-formed: unknown fields, bad types,
out-of-range replica counts, connection fields on a bundled datastore.
If that passes, the semantic rules decide whether the manifest
describes a stack that will actually work.

### What the rules catch

| Finding | Severity | Why |
|---|---|---|
| `paa-replicas` | error | PAA holds the transaction graph in process memory. A second replica takes half the Kafka partitions and builds its graph from half the traffic, so rings spanning both stop being visible. Nothing fails loudly. |
| `mla-replicas` | error | MLA keeps its retrain cooldown in process memory and holds no leader lease, so two copies can retrain at once and write over each other in the shared `models/` mount. |
| `fia-replicas` | warning | Safe, because each replica owns whole partitions and report writes are idempotent. The cost is roughly 16 GiB of RAM per copy. Rendering drops FIA's fixed host port when there is more than one. |
| `fia-enabled` | warning | Roughly 10 GB of disk, 16 GB of RAM, and a 7.6 GB download on first start. |
| `predict-unauthenticated` | warning | `require_api_key: false` leaves `POST /v1/predict` open to anything that can reach the port. |
| `prod-api-key`, `prod-jwt-secret`, `prod-cors` | error in production, otherwise warning | Mirrors RDA's own `warnIfUnsafeDefaults()`. RDA refuses to boot with `NODE_ENV=production` while any of these hold, unless `ALLOW_UNSAFE_PROD_DEFAULTS=true`. Catching it here means finding out before the containers start rather than from a crash loop. |
| `unresolved-reference` | error | An external datastore whose `${VAR}` never resolved would render a compose file pointing at the literal text. |
| `unresolved-reference-optional` | warning | Same, for a field the stack can start without, such as an external Redis password. |
| `sentinel-without-fia` | warning | The dashboard's investigation pages will show FIA as unavailable. They degrade to an empty state rather than erroring. |

### Resolving `${VAR}`

Any string in the manifest may hold `${VAR}` references. They resolve
from the process environment first and then from the `.env` file beside
the manifest, which is the order Compose itself uses, so exporting a
variable in your shell overrides the file for both.

An unresolved reference is left in place as its literal text so the
document still checks against the schema, and reported separately.

## Development

```bash
npm run build     # tsc into dist/
npm test          # jest
npm run lint      # eslint
```

Specs live under `test/`, with manifests under `test/fixtures/`. The
build tsconfig compiles `src/` only; `tsconfig.test.json` adds the specs
back for ts-jest.

`test/default-manifest.spec.ts` pins the committed `ojuri.yaml` at the
repo root against the `default.yaml` fixture and against the values in
`docker-compose.yml`. If you change the default stack, that spec is
where it will complain.

## `ojuri render [path]`

Turns the manifest into two files under `.ojuri/`, and prints the exact
Compose command that uses them.

```bash
ojuri render                    # write .ojuri/
ojuri render --print-command    # print the command, write nothing
ojuri render --build            # command for building from source
ojuri render --out-dir build/   # somewhere other than .ojuri/
```

It validates first and refuses to render a manifest with errors:
a rendered stack built on a broken manifest is worse than no stack,
because it looks like it worked. Warnings do not block.

### What it writes

`.env.rendered` holds the variables Compose substitutes that the
manifest controls: `OJURI_VERSION`, `RDA_REPLICAS`,
`RDA_REQUIRE_API_KEY`, `SENTINEL_CORS_ORIGINS`, and `MLA_HEALTH_URL`
when MLA is enabled. Your own `.env` is not touched. Compose reads
repeated `--env-file` in order with the last winning, so the printed
command passes yours first and this one second.

`docker-compose.override.ojuri.yml` carries only what the manifest
changes:

- **External datastores.** The bundled service is removed with `!reset`,
  and every dependant's `depends_on` is rebuilt with `!override`, which
  replaces the map rather than merging into it. Without that second
  step Compose rejects the project: `service "rda" depends on undefined
  service "postgres"`. The connection details are then written per
  service, because `docker-compose.yml` hardcodes `postgres`, `redis`
  and `kafka:29092` as literals that nothing in `.env` can redirect.
- **Observability off.** Prometheus and Grafana carry no Compose
  profile, so they are removed rather than withheld.
- **Replicas.** RDA scales through `RDA_REPLICAS` and nothing else. The
  others get `deploy.replicas`, and a service with a fixed host port
  loses it above one replica, since 9094 cannot be published twice.
- **Sentinel.** The shipped `nginx.conf` routes `/` to RDA, so enabling
  the profile alone starts a container nothing reaches. The nginx config
  bind mount is repointed at `nginx/nginx.sentinel.conf`, which is the
  same file with `/` going to Sentinel and an explicit `/v1/` carrying
  the API routes that used to fall through.

### The no-op property

Rendering the committed `ojuri.yaml` produces an empty overlay and an
`.env.rendered` whose values match `.env.example` exactly. The resolved
Compose project is then byte-identical to the README quick start's.

That is the whole point of the manifest, so it is enforced rather than
asserted: `.github/workflows/ci.yml` renders the default manifest and
diffs `docker compose config` both ways. `docker compose config` needs
no Docker daemon, so the job runs in seconds.

### One function, two commands

`SENTINEL_CORS_ORIGINS` is derived by `derivedCorsOrigins()` in
`src/manifest/cors.ts`. `validate` checks that value against RDA's
production guard and `render` writes it into the stack. If the two ever
computed it differently, validate would pass a manifest that renders to
a stack RDA refuses to boot. `test/render.spec.ts` pins them together.

## `ojuri init`

Writes `ojuri.yaml` and a `.env`, and refuses to overwrite either.

The `.env` is a copy of `.env.example` with the development defaults
replaced by generated secrets: `AUTH_JWT_SECRET`, `POSTGRES_PASSWORD`
and `ADMIN_SEED_PASSWORD`. Pass `--keep-dev-defaults` to copy it
verbatim instead.

Two things about that are worth knowing.

`POSTGRES_PASSWORD`, `DB_PASSWORD` and the password inside `DB_URL` all
move together. The container takes the first; host-side tooling reads
the other two. Changing one alone leaves a checkout where the stack
starts and `npm run db:migrate` cannot authenticate against it.

`ADMIN_SEED_PASSWORD` only takes effect on a **fresh database**. The
admin user is created inside a migration, so on a database where that
migration has already run the value is inert and the existing admin is
untouched. `npm run reset:admin` is the way in there.

`MLA_SERVICE_TOKEN` also ships a development default and is left alone
deliberately: hardening it is a separate change.

## `ojuri up [path]`

Validates, renders, starts the stack, waits for `db-migrate` to exit
cleanly and for RDA to answer `/ready` through NGINX, then prints the
predict URL, a runnable `curl` with a fresh UUID, and the admin
credentials situation.

```bash
ojuri up              # pull the published images
ojuri up --build      # build from source
ojuri up --yes        # skip the confirmations
```

It stops before starting anything if `postgres.mode` is `external`,
unless given `--yes`. `db-migrate` runs `seed:run` on every boot, and
against your own database that is a write to data this command does not
own.

### What it can tell you about the admin password

The admin user is created by a migration, which prints a banner only
when it generated the password itself. Three cases, three answers:

| Migration logs | What `up` says |
|---|---|
| Carries the seed banner | The generated password, quoted from the logs. It is not recoverable later. |
| Knex reports "Already up to date" | The database already existed; the admin is unchanged. |
| Migrations ran, `ADMIN_SEED_PASSWORD` set | The password is that value, if this run created the database. |

Guessing wrong here sends someone hunting for a password that was never
printed, so the fourth case says plainly that it cannot tell.

### Why it does not issue the first API key

`POST /v1/admin/api-keys` sits behind `denyIfPasswordRotation`, and the
seeded admin carries `mustChangePassword=true`, so the bootstrap
credential gets a 423 from every admin endpoint until the password is
rotated. Rotating it here would mean this command inventing a password
and consuming a deliberate security gate, so when
`auth.require_api_key` is true it prints the two steps instead.

## `ojuri status [path]`

Container state from `docker compose ps`, then a readiness probe per
enabled service.

Probes go through NGINX first, `/ready` for RDA and the proxied `/fia/`
and `/mla/` prefixes for those, falling back to the direct host ports.
That is the same both-ways approach `scripts/demo-traffic.mjs` already
takes, and it finds a service run natively alongside a Compose stack.

`RDA_HEALTH_URL` and friends override the list, but only when actually
set. They are commented out in `.env.example` and describe host-side
runs, so treating a comment as configuration would point every probe at
a port nothing is listening on.

## `ojuri down [path]`

Stops the stack. `--volumes` also deletes its data, which needs `--yes`:
that is the Postgres data, the Redis snapshot, the Kafka log, the
Grafana dashboards, and the FIA model cache, a 7.6 GB download to
rebuild.

## `ojuri doctor [path]`

Read-only host check, with no side effects beyond briefly binding the
ports it tests.

- Docker 20.10+ and Compose 2.24+. The Compose floor is real: the
  rendered overlay uses `!reset` and `!override`.
- Every host port the manifest's stack will publish, and only those. An
  external datastore needs none, a scaled FIA gives its port up, and
  observability off frees 9090 and 3001.
- External datastores actually accept a connection.
- With FIA enabled, whether the host has the RAM and disk, scaled by
  replica count. Always a warning, never an error: `FIA_DISABLE_LLM`
  exists and the operator may know something the check does not.
