# Upgrading

This document records the upgrade path between **major** versions
of Ojuri. Patch and minor upgrades are designed to be safe to
deploy without reading anything beyond `CHANGELOG.md` — see
[`VERSIONING.md`](VERSIONING.md) for the policy.

## v1.0.0

`v1.0.0` (2026-06-07) is the initial public release. There is no
prior version to upgrade from.

## From X.Y to Z.W *(template — remove this section when no longer
the most recent template; a major upgrade will replace it)*

When a future major release ships, the maintainer adding it to
this document should follow the shape below.

### What changed

A short, blunt summary of the breaking changes. Two or three
sentences, not a feature list. Adopters skim this to decide
whether they can do the upgrade in a coffee break or whether they
need to budget a week.

### Required actions

A numbered list of the exact steps an adopter has to take, in
order:

1. **Data migration.** What runs against Postgres, how long it
   takes on a representative dataset, whether it is online or
   requires downtime.
2. **Config changes.** Which `.env` variables changed name or
   semantics; which became required; which were removed.
3. **API changes.** Which request or response shapes changed;
   which endpoints moved or were removed; what the new shapes look
   like.
4. **Code changes adopters might have made.** If anyone is
   extending the feature catalogue, custom rules, or webhook
   signing, list any breaks here.
5. **Rollback plan.** How an adopter reverts if the new version
   misbehaves in their environment. Specifically — can they
   `docker compose down && docker compose up -d` against the
   previous tag, or does the schema migration prevent that?

### Compatibility window

If the previous major continues to receive security backports,
state the support window here. If not, say so plainly.

### Worked example

A copy-paste sequence the adopter can adapt:

```bash
# 1. Take a Postgres backup.
docker compose exec postgres pg_dump -U postgres fraud_db > pre-upgrade-backup.sql

# 2. Stop the stack.
docker compose down

# 3. Pin the new major in docker-compose.yml (or wherever you pin).
#    See VERSIONING.md for pinning strategy.

# 4. Pull and start.
docker compose pull
docker compose up -d

# 5. Run migrations (host-side, picks up the new migration files).
npm install
npm run db:migrate

# 6. Smoke-test the predict path.
curl -X POST http://localhost/v1/predict -H "Content-Type: application/json" \
     -d '{ ... see docs/API.md ... }'
```

Adopters running Helm, Terraform, or a custom orchestration will
adapt steps 3–4 accordingly. The substance — backup, stop,
upgrade, migrate, smoke — is the same.
