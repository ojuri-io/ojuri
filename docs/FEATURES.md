# Feature Catalogue

The platform's ONNX input tensor is defined by a single source of
truth: `models/feature-catalog.v1.json`. Every index is a named,
typed feature with a known computation path. Adopters extend the
catalogue without forking — drop a `models/feature-catalog.adopter.json`
file alongside the base and the next train + predict cycle picks it
up.

This page is the contract. Read it before changing any feature.

## Why a catalogue

Earlier revisions of the platform shipped a 434-dim input where only
~23 dimensions were real features; the remaining 411 were
zero-padding so a legacy PaySim model still loaded. That contract was
implicit and broken — PAA wrote a handful of named keys to Redis, MLA
zero-padded a DataFrame, RDA enriched a few positions, and any
disagreement between those three was a silent train/serve skew.

The catalogue makes the contract explicit and enforced:

- **Every index has a name** — `0` is `velocity_1m`, not "the first
  number". Adopters reading the audit log can identify what drove a
  decision.
- **Every name has a source** — `rda:request`, `rda:derived`,
  `paa:redis`, or `config:lookup`. The compiler / type system can't
  enforce this, but the loader does at boot.
- **Every model bakes its schema version into `meta.json`** — RDA's
  `OnnxService.applyActiveVersion` refuses to load a model whose
  schema version doesn't match the running catalogue. The class of
  bug we used to ship silently is now a loud failure at activation.

## The base catalogue (v1)

64 features across 9 categories. The file is the source of truth;
the table below is a summary.

| Range | Category | Count | Where it comes from |
|---|---|---|---|
| 0 – 11  | Velocity (sender) | 12 | PAA-computed counts and amount stats over 1m / 5m / 15m / 1h / 24h / 7d / 30d windows |
| 12 – 17 | Pair-wise (sender → receiver) | 6 | PAA: first-send flag, prior send count, time-since-last, round-trip count, mean amount, ratio to pair mean |
| 18 – 25 | Graph | 8 | PAA: PageRank, clustering coef, in/out-degree, community id, shortest path to known fraud, hub flag, neighbourhood fraud rate |
| 26 – 33 | Transaction | 8 | RDA from the request body: amount, z-score vs sender, type code, channel code, is_cross_border, is_inflow, is_recurring, currency code |
| 34 – 39 | Identity | 6 | RDA: customer age, account age, is_corporate, has_kyc_id, id_type_code, is_authenticated |
| 40 – 45 | Receiver | 6 | Mix: recipient KYC, same-FI, nationality match, age, lifetime tx count, dispute rate |
| 46 – 51 | Geographic | 6 | RDA: distances, IP-country mismatch, country risk band, cross-border-dest, sender country code |
| 52 – 57 | Device | 6 | Mix: VPN flag, trusted device, device type, agent-assisted, agent battery low, session-to-txn seconds |
| 58 – 63 | Calendar | 6 | RDA + PAA: hour, day of week, is_weekend, is_payday_window, is_off_hours, deviation from sender's typical hour |

## File layout

```
models/
├── feature-catalog.v1.json              # base, immutable (shipped with the repo)
├── feature-catalog.adopter.json         # optional adopter overlay (gitignore-able)
├── feature-catalog.adopter.example.json # demo overlay, copy to activate
└── lookups/
    ├── country_risk.json                # `compute.type: lookup` source files
    └── purpose_buckets.json
```

The base file ships with the repo. The overlay does not exist by
default. Adopters who want to add features create the overlay and the
loaders pick it up at the next service boot.

## Adopter overlay — declarative extension

An overlay declares features for indices 64–95 (32 slots) using a small
set of compute ops. No code, no Python or TypeScript module — pure
JSON. The same overlay file is read by RDA (TypeScript loader), MLA
(Python loader), and PAA (TypeScript loader) so all three see the
same column for the same index.

### Example

```jsonc
{
  "extends": "v1",
  "description": "ACME fintech adopter overlay",
  "features": [
    {
      "index": 64,
      "name": "amount_to_balance_ratio",
      "category": "adopter",
      "source": "rda:derived",
      "dtype": "float32",
      "default": 0,
      "description": "amount / walletBalance — wallet-drain indicator",
      "compute": {
        "type": "ratio",
        "numerator": { "field": "amount" },
        "denominator": { "field": "walletBalance" },
        "min_denominator": 1
      }
    },
    {
      "index": 65,
      "name": "channel_is_ussd",
      "category": "adopter",
      "source": "rda:derived",
      "dtype": "bool",
      "default": 0,
      "description": "Transaction came over a USSD channel",
      "compute": { "type": "equals", "field": "transactionChannel", "value": "USSD" }
    }
  ]
}
```

Save as `models/feature-catalog.adopter.json` and restart RDA + MLA.
Retrain. The new model has 66-dim input; RDA refuses to load any
model whose schema version doesn't match the new overlay SHA.

### Compute-op reference

Phase 1 ships the catalogue + loader + schema-version enforcement.
The compute-op execution lands in **Phase 2** (RDA enrichment) and
**Phase 3** (MLA training). The shapes below are the contract Phase
2 implementations must honour.

| `compute.type` | Args | Result | Notes |
|---|---|---|---|
| `from_field` | `field: string` | the field's value, cast to `dtype` | Strings cast via the encoding tables in `models/lookups/`. Missing field ⇒ `default`. |
| `equals` / `not_equals` | `field`, `value` | bool | String comparison, case-sensitive. |
| `is_one_of` | `field`, `values: array` | bool | |
| `ratio` | `numerator.field`, `denominator.field`, `min_denominator?: number` | float | Safe divide — if denominator below `min_denominator` (default 0), result = `default`. |
| `lookup` | `field`, `table` (path under `models/lookups/`), `default?` | numeric/categorical | Loaded once at boot. JSON object keyed by string field value. |
| `numeric_bucket` | `field`, `boundaries: number[]` | uint8 (bucket index) | Boundaries are inclusive upper bounds. |
| `bool_and` / `bool_or` | `refs: string[]` (other feature names) | bool | Refs must be prior features in the same overlay (no forward refs). |
| `from_redis` | `key: string` | float | Reads from `features:{senderId}` Redis hash. PAA writes the same key; train-side pulls it from the persisted feature snapshot. |
| `custom` | `resolver: string` | float | Delegates to a code-based resolver registered on both sides. See below. |

Op set kept deliberately small — every declarative op is auditable,
has a well-defined train-side implementation, and can't reach external
services. The `custom` op is the escape hatch for cases the algebra
can't express.

### Code-based custom resolvers (the `custom` op)

When a feature needs control flow the declarative ops can't express —
a multi-field heuristic, a call into another service, mixing Redis +
request + a lookup — wire a `custom` op and register a resolver of the
same name on **both** the RDA side and the MLA side. They MUST produce
the same value for the same inputs; the `feature_schema_version`
mechanism can't catch resolver drift (the catalogue file is identical),
so write a parity unit test.

Catalogue (`feature-catalog.adopter.json`):

```json
{
  "extends": "v1",
  "features": [
    {
      "index": 64,
      "name": "merchant_velocity_anomaly",
      "category": "adopter",
      "source": "rda:derived",
      "dtype": "float32",
      "default": 0,
      "description": "Adopter-side merchant-velocity heuristic.",
      "compute": { "type": "custom", "resolver": "merchant_velocity_anomaly" }
    }
  ]
}
```

RDA side (any file imported during boot — typical convention is
`src/custom-features/index.ts` imported from `src/bootstrap.ts`):

```ts
import { registerCustomFeature } from "@shared/features/custom-features";

registerCustomFeature("merchant_velocity_anomaly", (ctx, spec) => {
  const last5m = Number(ctx.redisFeatures["merchant_velocity_5m"] ?? 0);
  const baseline = Number(ctx.redisFeatures["merchant_velocity_30d_avg"] ?? 0);
  if (baseline <= 0) return Number(spec.default);
  return last5m / baseline;
});
```

MLA side (`mla-service/src/adopter/features.py`, imported from
`src/main.py` so registration happens before training starts):

```python
import numpy as np
import pandas as pd
from src.features.custom_features import register_custom_feature

def merchant_velocity_anomaly(df: pd.DataFrame, spec):
    last5m = pd.to_numeric(df.get("merchant_velocity_5m", 0), errors="coerce").fillna(0)
    baseline = pd.to_numeric(df.get("merchant_velocity_30d_avg", 0), errors="coerce").fillna(0)
    out = np.where(baseline > 0, last5m / baseline.replace(0, np.nan), spec.default)
    return out

register_custom_feature("merchant_velocity_anomaly", merchant_velocity_anomaly)
```

Failure modes are non-fatal by design: a missing or throwing resolver
logs once and returns the catalogue default for that feature — the
prediction still completes, the audit log still records, the model
trains on the same default in MLA.

Use `request_context` (the jsonb overflow column on `transactions`) to
carry adopter-only fields the catalogue resolver needs at train time
without adding a new migration each time.

## Schema versioning

The loader computes a runtime `schemaVersion` string:

- No overlay present → `"v1"`.
- Overlay present → `"v1+adopter:<first-12-hex-of-sha256>"`. The
  SHA is over the canonicalised JSON of the overlay file (keys
  sorted, no whitespace) so a re-save that only reformats doesn't
  change the version.

MLA stamps this string into every trained model's
`meta.json["feature_schema_version"]` and posts it on the
`modelVersions.metadata` JSONB column.

RDA's `OnnxService.applyActiveVersion` reads the version from the
incoming model row's `metadata`, compares to its own
`loadCatalog().schemaVersion`, and refuses to activate on a
mismatch. The previous session keeps serving traffic; the failed
load is logged at ERROR level with both version strings.

**What this prevents:**

| Scenario | Before catalogue | With catalogue |
|---|---|---|
| Operator drops a new adopter overlay on disk but forgets to retrain. New predicts use the new RDA enrichment but old model. | Silent column misalignment → broken predictions, no alarm. | RDA refuses to load the old model because its schema version doesn't match. Operator gets the loud error. |
| MLA retrains under a new overlay; RDA's overlay file is stale. | Silent column misalignment in the other direction. | RDA refuses the new model. Operator must sync the overlay first. |
| Two RDA replicas with mismatched overlays. | One replica predicts wrong, no signal. | The one with the wrong overlay refuses to load — `/readyz` stays UP for the predict path but the model is the previous version; metrics show the divergence. |

## Inspecting the running catalogue

`GET /v1/admin/features/catalog` (requires `models:read`) returns the
catalogue RDA is currently using, with every feature's index, name,
category, source, dtype, default, and adopter compute op when present.
The Sentinel dashboard's **Features** page (Config → Features) calls
this endpoint and renders a filterable table — read-only, because
editing the catalogue from the UI would require atomic re-fit of every
deployed model.

```bash
curl -s http://localhost:3000/v1/admin/features/catalog \
  -H "Authorization: Bearer $JWT" | jq '.data | { schemaVersion, inputDimension, adopterSha256 }'
```

```json
{
  "schemaVersion": "v1",
  "inputDimension": 64,
  "adopterSha256": null
}
```

When an overlay is present the `schemaVersion` carries the 12-char
SHA prefix and `adopterSha256` returns the full digest; that's the
exact value baked into model `meta.json` files.

## What ships in Phase 1

- `models/feature-catalog.v1.json` — the base catalogue (this file
  edited by-hand only).
- `models/feature-catalog.adopter.example.json` — a worked example
  adopters can copy.
- `src/shared/features/feature-catalog.{ts,types.ts}` — RDA loader.
- `mla-service/src/features/catalog.py` — MLA loader (mirror).
- Boot-time logging in `server.ts` (RDA) + `main.py` (MLA) showing the
  resolved version + dimension.
- `OnnxService.applyActiveVersion` schema-version enforcement.
- This document.

## Phase 2 — RDA enrichment

- `src/shared/features/feature-builder.ts` resolves every catalogue
  feature into a single `Float32Array`. Base features have hand-written
  resolvers; adopter features delegate to `compute-op-executor.ts`.
- `src/v1/modules/rda/services/feature.service.ts` no longer ships a
  434-dim default vector — it returns the raw Redis snapshot and lets
  the builder do the layout. Defaults are per-feature in the catalogue.

## Phase 3 — MLA training

- `mla-service/src/training/data_loader.py` builds the training matrix
  by iterating `catalog.features` and materialising each column from
  Postgres (`transactions`, `velocitySnapshots`, `graphMetadata`). No
  more 411-zero pad. Output dimension = `catalog.input_dimension`.
- `convert_to_onnx(num_features=catalog.input_dimension)` so the
  exported model's input shape matches the catalogue.
- Reviewer overrides write `groundTruthFraud` on the matching
  transaction row; the training query prefers it via `COALESCE`.

## Phase 4 — PAA Redis writes

- `paa-service/src/services/redis-update.service.ts` writes the
  canonical catalogue names (`amount_mean_30d`,
  `pair_time_since_last_send`, `graph_pagerank`, `graph_clustering_coef`,
  `graph_community_id`, `graph_in_degree`, `graph_out_degree`). The
  internal `CombinedFeatures` type keeps its old names — the rename is
  contained to the Redis wire boundary.

## Phase 5 — Sentinel "Features" page

- Read-only listing of the running catalogue with filters by category
  and source, plus a free-text search. Adopter-overlay features are
  flagged with an `overlay` pill so operators can see at a glance which
  rows are user-extension vs base.
- New admin endpoint `GET /v1/admin/features/catalog` documented above.

## What's coming next

- **Phase 6 (optional)** — Code-based custom features with parity
  testing for adopters who need ops the declarative compute algebra
  can't express (rare; most real-world features fit in `ratio`,
  `lookup`, `bool_and`, or `from_redis`).
