# Demo dataset

A small, curated set of 20 transactions for first-touch demos and
smoke-testing a fresh deployment.

## What's in here

`sample-transactions.json` is a hand-built mix:

- **~11 ACCEPT-shaped** — small payments, salary inflows, recurring bills,
  trusted devices, familiar geos.
- **~3 REVIEW-shaped** — mid-size unfamiliar merchant, unauthenticated WEB
  session, cross-border corridor.
- **~6 DECLINE-shaped** — very-large cash-out via a new agent, VPN + giftcard
  + foreign IP, velocity-spike burst from one sender to three mules, brand-new
  account immediately wiring out, geographic mismatch (NG IP, CA merchant).

Each entry has a `_note` field that explains its intent — the seed-load
script strips it before sending so the validator sees a clean payload.

The exact `decision` you'll get back depends on your active model
threshold and any rules you have enabled — the entries are *shaped* to
land in those buckets, but rules and thresholds are the source of truth.

> **Cold-start note.** Out of the box the ONNX model returns ACCEPT for
> every entry. Two reasons: (a) the model leans on graph + velocity features
> that PAA writes into Redis — empty on a fresh deploy, so RDA falls back
> to defaults; (b) the amount-level signals the dataset relies on aren't
> in the model's top-N reason codes. Running `npm run db:seed` first
> installs four demo rules (under `demo: …`) keyed on `amount`,
> `transaction_type`, and `segment`, which produces a roughly
> **9 ACCEPT / 4 REVIEW / 7 DECLINE** split immediately. Those rules are
> intentionally simple — replace them with your own once you've trained
> a model on your data.

## How to fire it

With a running RDA on `localhost:3000`:

```bash
npm run db:seed     # first run only — installs the four demo rules
npm run demo:load
```

That's `ts-node scripts/seed-load.ts --file data/demo/sample-transactions.json
--concurrency 4` under the hood. The script rewrites `transaction_id` and
`timestamp` on every send, so you can replay it freely without idempotency
collisions.

If `RDA_REQUIRE_API_KEY=true` on your deployment, pass an API key:

```bash
npm run demo:load -- --api-key fdk_xxx --tenant your_tenant_id
```

(`--` separates npm's args from the script's.)

## What to look at after firing

- **Sentinel dashboard** (`frontend/`) — the *Transactions* and *Decisions*
  tabs will show the 20 rows with their decisions and reason codes.
- **`GET /v1/admin/stats/today`** — accept/decline/review breakdown.
- **`GET /v1/admin/audit?limit=20`** — the raw `decisionAuditLog` rows.
- **FIA `/v1/reports`** — once PAA / FIA have consumed the
  `transactions.blocked` topic, the 6 declines will show up here with
  LLM-generated investigation narratives.

## Extending it

To add your own demo, drop another JSON array file under this directory and
point seed-load at it:

```bash
ts-node scripts/seed-load.ts --file data/demo/my-scenario.json
```

The required fields are the "core 8" from
[`docs/PREDICT-API.md`](../../docs/PREDICT-API.md): `transaction_id`,
`sender_id`, `receiver_id`, `amount`, `transaction_type`, `timestamp`,
plus whatever optional context fields the catalogue consumes.
