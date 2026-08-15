# Versioning

Ojuri follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Each release carries a single `MAJOR.MINOR.PATCH` version that applies to
every component the platform ships:

- **RDA** — Real-Time Detection Agent
- **PAA** — Pattern Analysis Agent
- **MLA** — Model Learning Agent
- **FIA** — Fraud Investigation Agent
- **Sentinel** — operator dashboard

These five services version in **lockstep**. There is no separate
PAA release stream, no out-of-band Sentinel bump — the tag
`v1.4.2` applies to all five images, all five published together.
That is the deal we make with adopters: one tag, one tested
combination, no inter-service compatibility matrix to reason
about.

## What changes at each level

### Patch — `v1.0.x`

Bug fixes only. A patch release is safe to deploy without reading
release notes (though we still encourage it).

- **No** changes to the public HTTP API (request or response shapes,
  status codes, error envelopes).
- **No** Postgres schema changes — no migrations in the release.
- **No** changes to `.env` variables or config file shapes that an
  adopter would have to set.
- **No** changes to Kafka topic names or message schemas.
- **No** changes to the feature catalogue (`models/feature-catalog.v1.json`)
  in a way that would invalidate a deployed model.

If an adopter pins to `:v1.0` they receive patch releases
automatically. If they pin to `:v1` (recommended) they receive
patch and minor releases automatically.

### Minor — `v1.x.0`

New features, additive only. Existing integrations keep working
without code changes on the adopter's side.

- New HTTP endpoints; new optional fields on existing endpoints.
  Existing fields keep their meaning.
- New Postgres tables; new columns on existing tables. Migrations
  are **additive only** — no destructive schema changes, no
  renames, no NOT NULL constraints added to existing columns
  without a default.
- New `.env` variables, all with sensible defaults so an existing
  `.env` file keeps working.
- New Kafka topics. Existing topics keep their schema; new optional
  fields may be added to existing message shapes.
- New rule operators, new feature-catalogue entries, new model
  registry transitions.

We will call out anything subtle in `CHANGELOG.md` under the minor's
"Changed" section. Reading the release notes for a minor bump is
recommended but not required for the platform to keep functioning.

### Major — `v2.0.0`

Breaking changes. Adopters need to plan the upgrade.

- Removals or renames in the HTTP API.
- Destructive Postgres migrations (column drops, type changes,
  NOT NULL constraints without backfill).
- Renamed `.env` variables, removed defaults, new required config.
- Kafka topic renames or message-schema breaks.
- Feature catalogue changes that invalidate currently-deployed
  models.

A major release **must** ship with an updated `UPGRADING.md`
section describing the upgrade path, any data migration, and any
configuration adopters need to change. We will not ship a major
release without that document being updated.

## What this means for adopters

If your `docker-compose.yml` (or Helm values, or whatever you
deploy from) pins to a floating `:v1` tag — the recommended
default — here is exactly what you will and will not see:

- **You will receive bug fixes automatically.** Patch releases land
  in the `:v1` tag the moment they are published.
- **You will receive new features automatically.** Minor releases
  also land in `:v1`. They are additive; your existing
  configuration and integrations keep working.
- **You will never receive a breaking change without explicit
  action.** A `v2.0.0` release ships to a new floating tag
  (`:v2`); your `:v1` deployment stays on the latest 1.x
  forever. Upgrading is something you choose to do, after
  reading `UPGRADING.md`.

If you want the strictest possible pinning — for example, in a
regulated production environment where you certify against a
specific image hash — pin to the exact version (`:v1.4.2`) or to
the image digest. You then take on the responsibility of
upgrading manually for each release.

## Why lockstep across all five services

The four backend services talk to each other through Kafka topics,
a shared Postgres schema, and a Redis feature hash. Sentinel talks
to RDA's `/v1/admin/*` and FIA's `/v1/reports*`. Versioning them
independently would create a combinatorial test surface (which PAA
version works with which RDA version works with which MLA-trained
model?) that we are not staffed to maintain.

Lockstep keeps the contract simple: when you upgrade, you upgrade
everything together, and the combination we publish is the
combination we test.

## Verify the artefact, not the branch

Anything under `src/`, `frontend/src/`, or `src/database/seeds/` is
compiled into a published image. Merging it to `main` changes nothing
for a running deployment until a release rebuilds that image — the
service keeps running the code it was built with.

This is easy to miss because it does not look like a build problem. It
looks like the fix not working: the setting is right, the branch is
merged, the deployment reports success, and the behaviour is unchanged.
During the 1.5.x cycle it happened four times — an ONNX runtime pin, a
seed file, and an API-key validator twice — and each cost a debugging
round before anyone thought to check the image.

After cutting a release, confirm the change is in the artefact rather
than only in the branch:

```bash
# Is the code actually in the image?
docker run --rm --entrypoint grep ghcr.io/ojuri-io/rda:v1 \
  -c isoDate /app/dist/v1/modules/admin/validations/api-key.validator.js

# Does the seed set match what main has?
docker run --rm --entrypoint ls ghcr.io/ojuri-io/rda:v1 \
  /app/dist/database/seeds | grep -c '\.js$'
```

A zero, or a count that disagrees with the branch, means the running
system does not have the fix regardless of what `git log` says.

There is a second copy of this trap in front of the first. Sentinel is
a hashed-bundle SPA, so a new image writes a new `index.html` pointing
at a new bundle — and a CDN keeps serving the old `index.html` until
its TTL lapses. Visitors then load the previous bundle from a stack
that is genuinely up to date.

What makes it costly is that the obvious check hides it:

```bash
# Lies. -H forces a revalidation, so this returns the new page while
# every browser still gets the cached one.
curl -s -H 'Cache-Control: no-cache' https://your-host/ | grep -o 'index-[^.]*\.js'

# Truthful — the request a visitor actually makes.
curl -s https://your-host/ | grep -o 'index-[^.]*\.js'
```

Compare that against the bundle the container holds. On the AWS
deployment `ojuri-up` invalidates automatically when the Sentinel image
changes; anywhere else, invalidate as part of the release.

## Pre-1.0 history

Pre-1.0 development happened on `main` without published images.
`v1.0.0` (2026-06-07) is the first tagged release; everything
before that is best regarded as unsupported.

## Related documents

- [`CHANGELOG.md`](CHANGELOG.md) — per-release detail. Read the
  entry for any minor or major bump before deploying.
- [`UPGRADING.md`](UPGRADING.md) — written when a major release
  ships. Not relevant for patch or minor upgrades.
- [`SECURITY.md`](SECURITY.md) — which versions receive security
  fixes (currently the latest 1.x minor).
- [`ROADMAP.md`](ROADMAP.md) — what is planned but not yet
  released.
