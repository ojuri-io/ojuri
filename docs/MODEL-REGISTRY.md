# Model Registry & Thresholds

The model registry is RDA's central source of truth for **which model
is in production**, **which is being shadowed**, and **what threshold
to apply** for each request.

## Two tables, one resolver

- `modelVersions` — registered model versions and their lifecycle status.
- `segmentThresholds` — optional per-`(segment, modelVersion)` thresholds
  that override the model's default.

`ModelRegistryService` (`src/shared/models/model-registry.service.ts`)
loads both into memory on startup and refreshes every
`MODEL_REGISTRY_REFRESH_MS` (default 30 s). The hot path calls
`resolve(segment)` which returns `{ championVersion, shadowVersion,
threshold }` — zero DB hits per prediction.

## Lifecycle

```
              ┌──────────┐    activate    ┌─────────┐    retire    ┌──────────┐
register ───► │ CANDIDATE│ ─────────────► │ ACTIVE  │ ───────────► │ RETIRED  │
              └──────────┘                └─────────┘              └──────────┘
                  │
                  │ shadow
                  ▼
              ┌──────────┐
              │  SHADOW  │
              └──────────┘
```

- **CANDIDATE** — registered, not yet routing traffic. The default.
- **SHADOW** — scored on every request, but its score does **not** drive
  the decision. Written to the audit log as `shadowScore` so you can
  compare distributions. Only one SHADOW at a time; promoting a new
  candidate to SHADOW demotes the previous one to CANDIDATE.
- **ACTIVE** — the champion. Exactly one at a time. Drives every decision.
- **RETIRED** — historical record only.

## Resolution order

Per request, the effective threshold is the first defined of:

1. `segmentThresholds.threshold` for `(segment, championVersion)`.
2. `modelVersions.defaultThreshold` for the champion.
3. `FRAUD_THRESHOLD` env var (only used before any model is registered).

So:

- A fresh deployment uses `FRAUD_THRESHOLD` as the global threshold.
- Registering and activating a model takes over with that model's
  `defaultThreshold`.
- Setting a per-segment threshold overrides further, for that segment only.

## Registering a model

```bash
curl -X POST http://localhost:3000/v1/admin/models \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "v1.2.0",
    "sourceUri": "s3://acme-models/fraud/v1.2.0.onnx",
    "sha256": "9b40…",
    "defaultThreshold": 0.6,
    "metrics": { "f1": 0.57, "auc": 0.91, "test_samples": 118108 }
  }'
```

`metrics` and `metadata` are free-form JSON blobs you can use to record
training context, hyperparameters, dataset hashes, etc. They surface
in `GET /v1/admin/models` and are searchable in SQL via `jsonb` operators.

> **Note** — registering a model creates the **metadata** record. The
> ONNX bytes themselves are still loaded by `OnnxService` from
> `MODEL_PATH` (or pulled by the `MODEL_REGISTRY_URL` poller). A
> future iteration will close that loop by fetching `sourceUri`
> automatically on activation.

## Updating threshold without re-registering

```bash
curl -X PATCH http://localhost:3000/v1/admin/models/v1.2.0 \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "defaultThreshold": 0.62 }'
```

Useful for nudging sensitivity in production without a deploy. The
new threshold is in effect within `MODEL_REGISTRY_REFRESH_MS`.

## Activating a model

```bash
curl -X POST http://localhost:3000/v1/admin/models/v1.2.0/status \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE" }'
```

Atomic transition:

1. Any other ACTIVE model is set to RETIRED with `retiredAt` stamped.
2. The target version is set to ACTIVE with `activatedAt` stamped.
3. Caches reload on all RDA replicas within 30 s.

## Running a shadow

```bash
curl -X POST http://localhost:3000/v1/admin/models/v1.3.0/status \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "status": "SHADOW" }'
```

The shadow's version label is recorded on every `decisionAuditLog` row.
Once the host loads the second ONNX session (see "Today's limitations"
below), `shadowScore` will also be populated.

Compare distributions:

```sql
SELECT
  width_bucket("championScore", 0, 1, 10) AS bucket,
  AVG("championScore"::float) AS champ_avg,
  AVG("shadowScore"::float)   AS shadow_avg,
  COUNT(*) AS n
FROM "decisionAuditLog"
WHERE "shadowScore" IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

## Per-segment thresholds

`segment` is an optional string passed in the `POST /v1/predict` body
(e.g. `"high_value"`, `"checkout_card_not_present"`,
`"p2p_transfer"`). Adopters use it to tighten or relax the model on
slices where the business risk profile differs from the global average.

```bash
curl -X POST http://localhost:3000/v1/admin/segment-thresholds \
  -H "X-Admin-Token: $RDA_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "segment": "high_value", "modelVersion": "v1.2.0", "threshold": 0.55 }'
```

`(segment, modelVersion)` is unique; re-posting upserts the threshold.

## Today's limitations

- **One ONNX session at a time** in `OnnxService`. The registry records
  shadow metadata, but you'd need to extend `OnnxService` to hold a
  second session before `shadowScore` is populated. This is intentional
  — for many adopters, the registry's metadata + audit log alone is
  enough to make A/B decisions offline against historical traffic.
- **No automatic promotion.** Champion/challenger logic (e.g. MLA's
  McNemar's test) lives offline in MLA. The platform exposes the
  endpoints; the decision to flip ACTIVE is human-driven.
