# Reason Codes

Every `/v1/predict` response includes a `reason_codes` array — the
top-N feature contributions that drove the decision. The same array
is persisted on the audit row and emitted in the `decision.created`
webhook.

This is the *fast* explanation, returned synchronously on every
prediction. For *deep* explanations (multi-paragraph narrative,
follow-up Q&A), use the FIA service.

## Shape

```json
"reason_codes": [
  { "code": "AMOUNT_HIGH",     "description": "Transaction amount relative to typical range", "contribution":  0.31, "value": 250000.0 },
  { "code": "VELOCITY_24H",    "description": "Transactions in the last 24 hours above baseline", "contribution":  0.18, "value":     47 },
  { "code": "PAGERANK",        "description": "Network-centrality score from the transaction graph", "contribution": -0.04, "value":    0.32 }
]
```

- `code` — stable machine-friendly identifier. Safe to store, route on,
  display in localized UI.
- `description` — short English description.
- `contribution` — signed score. **Positive** values push toward
  `DECLINE`; **negative** values push toward `ACCEPT`. Sorted by
  absolute magnitude.
- `value` — the raw feature value at request time. Useful for human
  reviewers ("velocity_24h was 47").

## Catalogue

Reason codes today surface 12 of the 64 catalogue features
(`models/feature-catalog.v1.json` — see [`FEATURES.md`](FEATURES.md)).
The other 52 still feed the model and shape the probability; they
just aren't surfaced as fast adverse-action codes. Full feature
attribution belongs in the FIA narrative, not on the predict
response.

| Code               | Drives                                                                |
|--------------------|-----------------------------------------------------------------------|
| `VELOCITY_1H`      | Transactions in the last hour above baseline                          |
| `VELOCITY_24H`     | Transactions in the last 24 hours above baseline                      |
| `VELOCITY_7D`      | Transactions in the last 7 days above baseline                        |
| `AVG_AMOUNT_30D`   | Sender's 30-day average transaction amount                            |
| `STD_AMOUNT_30D`   | Variance of sender's recent transaction amounts                       |
| `PAGERANK`         | Network-centrality score from the transaction graph                   |
| `CLUSTERING_COEF`  | How tightly the sender clusters with known peers                      |
| `TIME_SINCE_LAST`  | Seconds since the sender's previous transaction                       |
| `WEEKEND`          | Transaction occurred on a weekend                                     |
| `HOUR_OF_DAY`      | Hour of day deviates from sender's norm                               |
| `AMOUNT_HIGH`      | Transaction amount relative to typical range                          |
| `TRANSACTION_TYPE` | Transaction type associated with elevated risk                        |

## How the contributions are computed

```
z            = (value - baseline) / scale
contribution = weight * tanh(z)
```

`baseline`, `scale`, and `weight` are static, domain-tuned constants
defined in `src/shared/onnx/reason-codes.ts`. The math is intentionally
cheap — every microsecond on the predict path matters, and this isn't
the place for full SHAP.

`tanh(z)` saturates contribution magnitude at `weight`, so no single
feature can drown out the rest. The total fraud probability is **not**
the sum of contributions — the model itself is what computes that.
Reason codes only explain *direction and relative magnitude*.

## Updating the catalogue

The constants in `reason-codes.ts` are calibrated to the shipped
catalogue's defaults. Production deployments with a different feature
distribution should:

1. Run an offline SHAP analysis on a holdout sample.
2. Update `baseline` to the population mean, `scale` to the population
   std, and `weight` to the average absolute SHAP value for each
   feature.
3. Restart RDA — the catalogue is loaded at startup.

A future iteration will load these from `modelVersions.metadata` so
the catalogue can ship per-model without a code change.

## When `featuresDefault` is true

If Redis missed and `FeatureService` returned the population-default
features, the audit row's `featuresDefault` is `true` and the
contributions are all very small (everything sits at its baseline).
The reason codes are still emitted, but treat them as low-information
in that case.

## Localising for end-user notices

For an "adverse action notice" sent to a declined customer, map
`code` to your localised string in your application layer — do not
ship the English `description` directly to end users.

```
AMOUNT_HIGH     → "The transaction was larger than expected."
VELOCITY_24H    → "There were unusually many recent transactions on your account."
PAGERANK        → "(do not surface; internal-only)"
```

Don't include `value` or `contribution` numbers in customer-facing
notices — those are for analysts, not adverse-action recipients.
