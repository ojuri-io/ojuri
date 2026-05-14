# Training the Fraud Detection Model

How to train, retrain, and promote fraud-detection models against your
own data. The Model Learning Agent (MLA) owns this pipeline end to end
— labelled-data load, preprocessing, training, A/B gate, ONNX export,
and registration with RDA for hot-reload.

> Cross-references: feature contract is in
> [`FEATURES.md`](./FEATURES.md); model lifecycle and admin endpoints
> are in [`MODEL-REGISTRY.md`](./MODEL-REGISTRY.md). This doc is the
> operator runbook that connects the two.

## TL;DR

- **Cold start (no model yet):** `cd mla-service && python -m src.main --train`. MLA loads from `transactions` (or falls back to synthetic data), trains, exports `models/versions/<v>/`, and — if `RDA_API_URL` + `MLA_SERVICE_TOKEN` are set — registers + activates the new version on RDA without a restart.
- **Production loop:** `python -m src.main` (no flag). MLA consumes `transactions.completed` from Kafka, watches F1 and PSI on the `amount` feature, and retrains automatically when either threshold trips.
- **Promotion is gated.** New models are deployed only if McNemar's test against the current production model passes (`p < 0.05`) AND F1 improves by at least `min_improvement` (default 1%). Failed candidates are discarded; the previous ACTIVE keeps serving.
- **Schema-version contract is enforced.** Each trained model bakes the running `feature_schema_version` into its `meta.json`. RDA refuses to load a model whose schema doesn't match the running catalogue and logs `Refusing to load model — feature schema mismatch`. Retrain after any overlay change.
- **Filesystem-only.** There is no MinIO/S3 in this distribution. `models/versions/<version>/` IS the registry. Deletion is via `DELETE /v1/admin/models/:version` (requires `models:delete`).

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Python | 3.11 (matches the `python:3.11-slim` Dockerfile) |
| Host RAM | ~2 GB free for `TRAINING_DATA_SIZE=50000` (default). Production sizes of 500k+ need ~16 GB. |
| Disk | Each trained version is ~1–10 MB on disk (`model.onnx` + `model.pkl` + `scaler.npz` + `meta.json`). Plan ~100 MB per 10 versions. |
| Postgres | Reachable `fraud_db` with the `transactions` table (RDA migrations have been run). Default port in dev is `5433`. |
| Kafka | Required for **production** mode (`python -m src.main`). Not required for `--train` cold-start. |
| RDA | Optional for cold-start. Required for automatic registration + ACTIVATE; otherwise operator activates via the admin UI. |

The MLA venv is separate from RDA and PAA — root `npm install` does not touch it.

```bash
cd mla-service
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

> ONNX library pins matter. `requirements.txt` pins `onnx==1.13.0`,
> `onnxmltools==1.10.0`, `onnxconverter-common==1.12.0`. Newer
> releases break XGBoost-to-ONNX conversion with
> `TypeError: Field onnx.AttributeProto.ints: Expected an int, got a boolean`.
> Don't bump them without re-validating the full train → ONNX → RDA
> inference path.

### Environment variables MLA reads

| Variable | Default | Purpose |
|---|---|---|
| `KAFKA_BROKERS` | `localhost:9092` | Drift-monitor consumer for `transactions.completed`. Not needed for `--train`. |
| `POSTGRES_HOST` | `localhost` | Postgres host. |
| `POSTGRES_PORT` | `5433` | Dev Docker maps host `5433` → container `5432`. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `fraud_db` / `postgres` / `postgres` | Postgres credentials. |
| `RDA_API_URL` | unset | e.g. `http://rda:3000`. If set with `MLA_SERVICE_TOKEN`, MLA auto-registers and activates new versions. |
| `MLA_SERVICE_TOKEN` | unset | Bearer token with `models:write` permission. |
| `TRAINING_DATA_SIZE` | `50000` | Max rows pulled from `transactions` per training run. |
| `DRIFT_F1_THRESHOLD` | `0.92` | Below this, MLA retrains. |
| `DRIFT_PSI_THRESHOLD` | `0.25` | Above this on `amount`, MLA retrains. |
| `DRIFT_WINDOW_SIZE` | `1000` | Sliding window for drift signal. |
| `SMOTE_RATIO` | `1.0` | Minority-class oversampling ratio (1.0 = balanced). |
| `MODEL_OUTPUT_DIR` | `../models` | Where versioned directories are written. The default points at repo-root `models/` so RDA's bind-mount sees them. |
| `METRICS_PORT` | `9095` | `/livez`, `/readyz`, `/stats` HTTP surface. |

Copy `mla-service/.env.example` to `mla-service/.env` and edit. The `Config` class loads it on import via `python-dotenv`.

---

## Data Requirements

MLA reads from a single Postgres table: `transactions` (owned by RDA's Knex migrations). The relevant schema:

| Column | Source | Used for |
|---|---|---|
| `transactionId`, `senderId`, `receiverId` | `20240413000001_create_transactions_table.ts` | Row keys, not features. |
| `amount` (decimal 15,2) | as above | Feature + PSI drift signal. |
| `transactionType` (string) | as above | One-hot encoded feature. |
| `createdAt` / `timestamp` (bigint) | as above | Time-of-day / day-of-week features. |
| `fraudLabel` (boolean, nullable) | populated post-hoc by chargeback ingestion or manual review | Training label. NULL rows are excluded. |
| `fraudProbability` (float, nullable) | written by RDA | Audit, not used for training. |
| `deviceFingerprint` (jsonb, nullable) | RDA | `has_device_fp` indicator feature. |
| `decisionSource` (string, nullable) | `20260514000001_add_decision_source_to_transactions.ts` | **Rule-leak filter — see below.** |
| `ruleName` (string, nullable) | as above | Audit trail. |

### Why `fraudLabel` matters

`fraudLabel` is **ground-truth fraud** — the column you set when a chargeback comes in, a reviewer confirms fraud, or a customer disputes the charge. Labels arrive **3–7 days late** in real systems; the drift detector is designed around that lag (see comment block in `data_loader.py`).

The training query is:

```sql
SELECT ... FROM transactions
WHERE "fraudLabel" IS NOT NULL
  AND ("decisionSource" IS NULL OR "decisionSource" = 'ML')
ORDER BY "createdAt" DESC
LIMIT :limit
```

The `decisionSource = 'ML'` filter is **load-bearing**: `fraudLabel` in the open distribution is currently set to `finalDecision == 'DECLINE'`. Without the filter, a PRE/POST rule that blocks a large but legitimate payment leaks into the training set as a "fraud" example, and the next model learns to mimic the rule — a self-reinforcing loop with no ground-truth signal. NULL is treated as ML for backward-compatibility with rows written by pre-rules-engine PAA builds. Longer-term, populate a separate `groundTruthFraud` column from chargebacks and train on that instead.

### Minimum row counts

| Use case | `fraudLabel IS NOT NULL` rows needed | Notes |
|---|---|---|
| Smoke test | ~100 | Pipeline runs; metrics are noise. |
| Reasonable dev model | ~10,000 | F1 stabilises around the test distribution. |
| Production | 100,000+ | Required for the McNemar A/B gate to have power. |
| Both classes present | At least 6 minority-class samples | Below this `SMOTE` is skipped (`_apply_smote` falls through). |

When zero labelled rows are found, `DataLoader._generate_synthetic_data()` produces up to 10k synthetic rows with a ~2% base fraud rate. The training run logs `⚠️ GENERATING SYNTHETIC DATA FOR DEVELOPMENT` so you can't miss it. **Useful for smoke tests, not for any real metric.**

---

## Cold Start (No Model Yet)

```bash
cd mla-service
source venv/bin/activate

# Point at Postgres + (optionally) RDA admin
export POSTGRES_HOST=localhost POSTGRES_PORT=5433
export RDA_API_URL=http://localhost:3000
export MLA_SERVICE_TOKEN=<bearer token with models:write>

# Train + register + activate in one call
python -m src.main --train
```

### What `--train` does

`MLAService.train_initial_model()` calls `_run_training_pipeline({'reason': 'initial_training'})` directly, skipping Kafka. The seven steps from `mla-service/src/main.py`:

1. **Load training data** — `DataLoader.load_training_data(limit=TRAINING_DATA_SIZE)`. Synthetic fallback if no labelled rows.
2. **Preprocess** — `DataPreprocessor.preprocess()`: stratified train/val/test split (60/20/20), SMOTE on training only (never on val/test), `StandardScaler` fit on training and applied to all three.
3. **Train XGBoost** — `ModelTrainer.train()` with the hyperparameters from `Config`.
4. **A/B test** — `ModelValidator.ab_test()` against the current ACTIVE pickle. **Cold start has no current model**, so this step is skipped and the new model is deployed unconditionally.
5. **Convert to ONNX** — `ONNXConverter.convert_to_onnx()` writes `fraud_model_<v>.onnx` and `fraud_model_<v>_scaler.npz` to `MODEL_OUTPUT_DIR`.
6. **Upload to registry** — `ModelRegistry.upload_model()` materialises the versioned directory and (if RDA env is set) POSTs to register + activate.
7. **Update MLA state** — bumps `next_version`, resets the drift baseline using the just-trained feature distributions.

### Where the artefacts land

`MODEL_OUTPUT_DIR` defaults to `../models` (the repo-root directory shared with RDA via bind-mount). After a successful run:

```
models/
├── fraud_model_v1.0.onnx          ← intermediate (written by ONNXConverter)
├── fraud_model_v1.0_scaler.npz    ← intermediate scaler
└── versions/
    └── v1.0/
        ├── model.onnx             ← the artefact RDA loads via sourceUri
        ├── model.pkl              ← XGBoost pickle, needed for next A/B test
        ├── scaler.npz             ← co-located so RDA-side ONNX inputs match
        └── meta.json              ← training metrics + feature_schema_version + SHA-256
```

`meta.json` example (truncated):

```json
{
  "version": "v1.0",
  "sha256": "9b40...",
  "feature_schema_version": "v1",
  "feature_input_dimension": 64,
  "f1_score": 0.554,
  "auc_roc": 0.911,
  "training_data_size": 30000,
  "uploaded_at": "2026-05-13T14:22:01Z"
}
```

`sha256` is the digest of the on-disk `model.onnx`. `feature_schema_version` comes from `load_catalog().schema_version` — see [`FEATURES.md`](./FEATURES.md) for how it's computed.

### Verifying activation

If `RDA_API_URL` + `MLA_SERVICE_TOKEN` were set, MLA POSTs to RDA twice: first to register the candidate, then to flip it to ACTIVE. The pipeline logs:

```
✅ RDA register: v1.0 (201)
✅ RDA activate: v1.0 ACTIVE
```

Confirm from the operator side:

```bash
# What does RDA think is ACTIVE?
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/v1/admin/models | jq '.data[] | select(.status=="ACTIVE")'

# And in Postgres directly:
psql -h localhost -p 5433 -U postgres -d fraud_db \
  -c 'SELECT version, status, "activatedAt", "defaultThreshold" FROM "modelVersions" ORDER BY "createdAt" DESC LIMIT 5;'
```

RDA's `ModelRegistryService` refreshes its in-memory cache every `MODEL_REGISTRY_REFRESH_MS` (default 30 s). `OnnxService` subscribes to `onActiveChange` and hot-swaps the loaded session — **no RDA restart needed**.

If `RDA_API_URL` is unset (or RDA is unreachable), MLA logs:

```
RDA_API_URL / MLA_SERVICE_TOKEN not configured — MLA will write versions locally
but won't auto-register with RDA. Activate manually via the admin UI.
```

The model is still on disk under `models/versions/v1.0/`. Operator activates manually:

```bash
curl -X POST http://localhost:3000/v1/admin/models \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "version": "v1.0", "sourceUri": "models/versions/v1.0/model.onnx", "sha256": "<from meta.json>" }'

curl -X POST http://localhost:3000/v1/admin/models/v1.0/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE" }'
```

---

## Bringing Your Own Data

Three paths, in order of decreasing operator overhead.

### (a) Bulk-load your CSV/parquet into `transactions`

Recommended when you have a labelled historical dataset. MLA picks up whatever satisfies the `WHERE "fraudLabel" IS NOT NULL AND "decisionSource" = 'ML'` filter.

```sql
-- Minimal columns you must populate. timestamps are unix ms (bigint).
INSERT INTO transactions (
  "transactionId", "senderId", "receiverId",
  amount, "transactionType", timestamp,
  "fraudLabel", "decisionSource"
)
SELECT
  txn_id, sender, receiver,
  amt, type, EXTRACT(EPOCH FROM ts) * 1000,
  is_fraud, 'ML'        -- mark as ML-decided so MLA includes the row
FROM staging.my_labelled_transactions;
```

A few notes:

- Setting `decisionSource = 'ML'` on bulk-loaded rows is intentional — these are training rows, not real decisions, but the filter must pass.
- `senderId` / `receiverId` are strings, not foreign keys — MLA doesn't join them.
- Indexes (`idx_transactions_ml_training`) cover the read path; no manual index work needed.

Then run cold-start training as above.

### (b) Train from external datasets via `train_with_datasets.py`

The repo ships `mla-service/scripts/train_with_datasets.py` with built-in loaders for **IEEE-CIS Fraud Detection** and **PaySim** (Kaggle datasets — download them via `scripts/download_datasets.py` first):

```bash
cd mla-service
python scripts/download_datasets.py                  # fetches IEEE-CIS + PaySim into data/
python scripts/train_with_datasets.py                # both datasets combined
python scripts/train_with_datasets.py --ieee-only    # IEEE-CIS credit-card fraud only
python scripts/train_with_datasets.py --paysim-only  # PaySim mobile-money only
python scripts/train_with_datasets.py --synthetic    # local synthetic generator
python scripts/train_with_datasets.py --ieee-samples 100000 --paysim-samples 10000  # capped
```

This script bypasses Postgres entirely and loads the public datasets directly. It does **not** wire into the `ModelRegistry.upload_model()` path used by `python -m src.main --train` — it predates the filesystem registry and writes intermediate `fraud_model_v1.0.onnx` / `.pkl` / `_metadata.json` to `MODEL_OUTPUT_DIR` only.

> **Discrepancy flagged:** the `--skip-registry` flag in this script and in `scripts/train_initial_model.py` still references "MinIO" in help text and calls `registry.is_available()` / `registry.upload_model(model_path=..., onnx_path=..., metadata=...)`. The current filesystem-backed `ModelRegistry` (see `mla-service/src/deployment/model_registry.py`) has no `is_available()` method and its `upload_model` signature is `(model, model_path, version, metadata)`. The standalone scripts will fail at the registry step and fall through to the local-only path. **Treat `python -m src.main --train` as the canonical training entry point**; the standalone scripts are useful for ad-hoc training against the public datasets and then activating the resulting ONNX manually via the admin API.

After a `train_with_datasets.py` run, register the result manually:

```bash
# Copy into the versions layout RDA expects
mkdir -p ../models/versions/v1.0
cp ../models/fraud_model_v1.0.onnx ../models/versions/v1.0/model.onnx
cp ../models/fraud_model_v1.0.pkl  ../models/versions/v1.0/model.pkl

# Compute the SHA and POST it
SHA=$(sha256sum ../models/versions/v1.0/model.onnx | cut -d' ' -f1)
curl -X POST http://localhost:3000/v1/admin/models \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"version\":\"v1.0\",\"sourceUri\":\"models/versions/v1.0/model.onnx\",\"sha256\":\"$SHA\"}"
curl -X POST http://localhost:3000/v1/admin/models/v1.0/status \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"ACTIVE"}'
```

### (c) Live data accumulating from `/v1/predict`

Once RDA is serving traffic, PAA writes a `transactions` row per decision and your labelling pipeline (or chargeback ingestion) eventually sets `fraudLabel`. When enough labelled rows exist, run `python -m src.main` (no `--train`). MLA watches Kafka, detects drift, retrains automatically, A/B tests, and promotes — no manual intervention.

For this to be useful, your labelling pipeline must keep up. The `data_loader.py` logs `Average label age: X days (expected: 3-7 days)` so you can spot a stuck labeller from MLA's stdout.

---

## Drift-Triggered Retraining (Production Mode)

```bash
cd mla-service && source venv/bin/activate
python -m src.main                            # consumer + monitor + retrain loop
```

This is the long-running production form. MLA:

1. Starts the HTTP server on `METRICS_PORT` (default 9095) — `/livez`, `/readyz`, `/stats` come up even if Kafka is down.
2. Loads the current production model from the registry (RDA `/v1/admin/models` ACTIVE row; filesystem fallback if RDA is unreachable). Sets `self.current_model` (XGBoost pickle for A/B) and `self.current_model_version`.
3. Connects to Kafka. Consumes `transactions.completed`. Pushes labelled events into the `DriftDetector` sliding window.
4. Every event, the detector computes F1 over the window and PSI on the `amount` feature. When either threshold is breached, `on_drift_detected` fires.
5. `_run_training_pipeline` runs the same 7-step flow as `--train`, but with the A/B gate active (step 4 in cold-start above).

### Tuning the thresholds

| Threshold | Default | Tighter (more retrains) | Looser (fewer retrains) |
|---|---|---|---|
| `DRIFT_F1_THRESHOLD` | `0.92` | `0.95` | `0.85` |
| `DRIFT_PSI_THRESHOLD` | `0.25` | `0.15` | `0.40` |
| `DRIFT_WINDOW_SIZE` | `1000` | `500` (faster reaction, noisier) | `5000` (slower reaction, smoother) |

PSI buckets reference: `0–0.10` = no shift, `0.10–0.25` = moderate shift, `>0.25` = significant shift. Adjust based on your traffic pattern — a system that processes 10 req/s reacts very differently from one at 1000 req/s with a 1000-event window.

`stats` exposes the live counters:

```bash
curl http://localhost:9095/stats | jq
# {
#   "service": "mla",
#   "drift_checks": 42031,
#   "drift_detected_count": 3,
#   "retrainings_started": 3,
#   "retrainings_succeeded": 2,
#   "retrainings_failed": 1,
#   "current_model_version": "v1.2",
#   "retraining_in_progress": false,
#   ...
# }
```

---

## The A/B Test Gate

`ModelValidator.ab_test()` runs on the held-out test set (the 20% never seen by training or validation, with `decisionSource='ML'` filtering preserved):

1. Both models score the same `X_test`.
2. F1, precision, recall, AUC-ROC computed for each.
3. **McNemar's test** with continuity correction on disagreements — `chi2 = (|b-c| - 1)² / (b+c)`, where `b` is the count where the old model was wrong and the new model right, `c` the reverse.
4. Decision rule (`ModelValidator._make_decision`):
   - **DEPLOY_NEW_MODEL** when **all** of:
     - F1 improvement ≥ `min_improvement` (default 0.01)
     - `p_value < 0.05`
     - Precision did not drop below 95% of the old precision
     - Recall did not drop below 95% of the old recall
   - **DEPLOY_NEW_MODEL** (fallback) when F1 improvement ≥ `min_improvement` even if not statistically significant — this kicks in on small test sets where McNemar has no power.
   - **KEEP_CURRENT_MODEL** otherwise.

When `b + c < 10` (fewer than 10 disagreements), McNemar returns `p=1.0` and the significance check fails — the fallback path is the only way to ship in that case.

Failed candidates log:

```
⚠️  NEW MODEL NOT BETTER THAN CURRENT
   Keeping current production model
   No deployment will occur
```

The pipeline returns without uploading or calling RDA. `retrainings_failed` ticks; the previous ACTIVE keeps serving.

---

## Schema-Version Contract

Every trained model bakes the running `feature_schema_version` into `meta.json` (and into the `metadata` JSONB column when registered with RDA). RDA's `OnnxService.applyActiveVersion` reads it back at load time and refuses on mismatch.

The exact error you'll see in RDA logs:

```
ERROR  applyActiveVersion: Refusing to load model — feature schema mismatch
       { reported: 'v1', expected: 'v1+adopter:9b40ab12cd34' }
Error: Feature schema mismatch: model was trained against 'v1',
       running catalogue is 'v1+adopter:9b40ab12cd34'.
       Either retrain the model against the current catalogue
       or revert the adopter overlay.
```

This fires on the ACTIVATE call (or on the next `MODEL_REGISTRY_REFRESH_MS` cache refresh, whichever comes first). The previous ONNX session keeps serving traffic; the failed load is the loud signal.

**When this trips:**

| Trigger | Fix |
|---|---|
| You added `models/feature-catalog.adopter.json` since the last train. | Retrain — MLA reads the same overlay and stamps the new version. |
| You edited the overlay (changed a feature, added an index). The SHA changed. | Retrain. |
| You ran MLA against a different overlay than RDA has on disk (e.g. different containers, stale bind-mount). | Sync the overlay file across all replicas, then retrain. |
| You're trying to activate an old model after an overlay change. | Either retrain against the current catalogue, or revert the overlay if the old model is the one you want. |

The version string scheme:

- No overlay → `"v1"`.
- Overlay present → `"v1+adopter:<first-12-hex-of-sha256>"`, where the SHA is over canonicalised JSON (keys sorted, whitespace stripped).

A re-save that only reformats won't change the version. Changing a feature's `compute.field` will.

---

## Verifying the New Model is Live

Once ACTIVE, the new version label appears on every prediction response (`modelVersion`) and in the `decisionAuditLog.modelVersion` column.

```bash
# Predict against a sample payload
curl -X POST http://localhost:3000/v1/predict \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "test-001",
    "senderId": "S1", "receiverId": "R1",
    "amount": 1500.00, "transactionType": "TRANSFER",
    "timestamp": 1715600000000
  }' | jq '{decision, modelVersion, fraudProbability}'
```

Expected (with the v1.2 you just promoted):

```json
{
  "decision": "ALLOW",
  "modelVersion": "v1.2",
  "fraudProbability": 0.034
}
```

If `modelVersion` is still the old one 30+ seconds after activation, check `GET /v1/admin/models` — the row may be ACTIVE in Postgres but the ONNX bytes may have failed to load on disk (schema mismatch, missing file, bad permissions). RDA logs at ERROR level when that happens.

---

## Operational Concerns

### Disk usage

Each `models/versions/<v>/` is ~1–10 MB (ONNX is small; pickle and scaler dominate). MLA never deletes old versions on its own — that's an operator decision.

### When to delete old versions

| Status | Safe to delete? | How |
|---|---|---|
| ACTIVE | No — `DELETE` returns 409. Retire first. | `POST /v1/admin/models/<v>/status {"status":"RETIRED"}` |
| SHADOW | No, same reason. | Retire first. |
| RETIRED | Yes, when you're sure you won't need to roll back to it. | `DELETE /v1/admin/models/<v>` (requires `models:delete`) |
| CANDIDATE | Yes — never served traffic. | `DELETE` directly. |

Deletion removes both the Postgres row AND the on-disk `models/versions/<v>/` directory. See [`MODEL-REGISTRY.md`](./MODEL-REGISTRY.md) for the full lifecycle.

### Retention guidance

Keep at least the last 2–3 RETIRED versions for rollback. After that, delete in batches — operators with audit obligations may need to keep models referenced by old `decisionAuditLog` rows reproducible, in which case the lifecycle is "RETIRED forever" and disk grows linearly. Plan accordingly.

```bash
# List retired versions older than 30 days
psql -h localhost -p 5433 -U postgres -d fraud_db -c "
  SELECT version, \"retiredAt\"
  FROM \"modelVersions\"
  WHERE status = 'RETIRED' AND \"retiredAt\" < NOW() - INTERVAL '30 days'
  ORDER BY \"retiredAt\";
"
```

### Memory ceiling during training

`TRAINING_DATA_SIZE=50000` is laptop-friendly (~1 GB RAM during SMOTE + scaler fit). `500000` needs ~10 GB. SMOTE's memory peak is roughly `2 * n_minority_after_smote * num_features * 4 bytes`. For 434-dim features and a balanced 250k sample SMOTE, that's ~870 MB just for the resampled training array — plus the temporary copy XGBoost makes.

If you OOM, the first lever is `TRAINING_DATA_SIZE`, then `SMOTE_RATIO` (set to 0.5 to leave the minority class at half-parity, halving the post-SMOTE row count).

---

## Troubleshooting

### "No labeled transactions found in database!"

```
❌ No labeled transactions found in database!
   Possible reasons:
   1. No transactions have been labeled yet (need 3-7 day delay)
   2. Labeling process not running
   3. Database connection issue
⚠️  GENERATING SYNTHETIC DATA FOR DEVELOPMENT
```

The query returned zero rows. Check in order:

```bash
# 1. Are there labels at all?
psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -c '
  SELECT "fraudLabel", COUNT(*) FROM transactions GROUP BY "fraudLabel";
'

# 2. Are they all rule-driven? (decisionSource filter excludes non-ML)
psql ... -c '
  SELECT "decisionSource", COUNT(*) FROM transactions
  WHERE "fraudLabel" IS NOT NULL GROUP BY "decisionSource";
'
```

If everything is `decisionSource = 'RULE_PRE'` or `'RULE_POST'`, the filter is working correctly — you genuinely have no ML-decided labelled rows. Either run more traffic past RDA, or bulk-load training rows tagged `decisionSource = 'ML'`.

### RDA registration fails

MLA logs one of:

```
RDA register returned 401: ... — version is on disk; activate via UI
RDA register returned 403: ... — version is on disk; activate via UI
RDA bridge unreachable (...) — model is on disk; activate via UI
```

The model **is** on disk under `models/versions/<v>/`. MLA degrades gracefully — operator activates from the admin UI or via direct `curl` (commands in the cold-start section).

For 401/403: regenerate `MLA_SERVICE_TOKEN` with the `models:write` permission. For unreachable: check `RDA_API_URL` and network reachability from MLA's environment.

### Schema-version mismatch on activation

See the [Schema-Version Contract](#schema-version-contract) section. Short version: retrain against the current overlay, or revert the overlay if the existing model is the one you actually want.

### Out-of-memory during SMOTE

Symptoms: process killed by OOM, or `MemoryError: Unable to allocate ...` in the SMOTE step.

Mitigations (in order of preference):

1. Drop `TRAINING_DATA_SIZE` (e.g. 50000 → 10000).
2. Drop `SMOTE_RATIO` (1.0 → 0.5 — minority class half-parity instead of full parity).
3. Increase host RAM or run on a beefier box.
4. Disable SMOTE entirely by setting `SMOTE_RATIO=0.01` (preprocessor falls through with `"Classes already balanced, skipping SMOTE"` when the ratio is already met).

### ONNX conversion failure

```
TypeError: Field onnx.AttributeProto.ints: Expected an int, got a boolean.
```

Library drift — somebody upgraded `onnxmltools` or `onnx`. Restore the pins:

```bash
pip install onnx==1.13.0 onnxmltools==1.10.0 onnxconverter-common==1.12.0
```

Then re-run training. Don't bump the pins without testing the full train → ONNX → RDA inference path end-to-end.

### "Pickle file not found - cannot load for A/B testing"

Logged at MLA boot when the registry has an ONNX but no co-located pickle:

```
⚠️  Pickle file not found - cannot load for A/B testing
   First retraining will deploy without comparison
```

Means somebody activated a model whose `models/versions/<v>/model.pkl` is missing. The next retrain will skip the A/B gate and deploy unconditionally. To recover the A/B gate without retraining, drop a matching `model.pkl` next to the ONNX (or accept that you'll have one unconditional deploy and the gate returns afterward).

### Drift never trips

Two common causes:

1. **Window full of NULL labels.** The drift detector only counts events with `fraudLabel IS NOT NULL`. If your labelling pipeline is broken, the window fills slowly or never. `/stats` shows `drift_checks` ticking but the F1 calculation is over too few labelled events to be meaningful.
2. **Thresholds are too loose.** Default `0.92` F1 and `0.25` PSI are conservative. If you're running a small synthetic workload, you may genuinely never breach them. Drop the thresholds for testing.

### `python -m src.main` exits immediately

Check the boot logs. The most common cause is a Postgres connection failure during `_load_production_model` — MLA needs to read the active version row even if there is none. Confirm:

```bash
psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $POSTGRES_DB -c '\dt' >/dev/null
```

If that works, double-check `Config.validate()` — `DRIFT_F1_THRESHOLD` outside `(0, 1]` or `TRAINING_DATA_SIZE <= 0` will raise on import.

---

## Reference Files

- `mla-service/src/main.py` — `MLAService` orchestrator + `_run_training_pipeline`.
- `mla-service/src/training/data_loader.py` — Postgres training-data query with the `decisionSource = 'ML'` rule-leak filter and the 434-dim feature pad.
- `mla-service/src/training/preprocessor.py` — split + SMOTE + scaler.
- `mla-service/src/training/trainer.py` — XGBoost fit + metrics.
- `mla-service/src/training/validator.py` — A/B test + McNemar.
- `mla-service/src/deployment/onnx_converter.py` — XGBoost → ONNX export.
- `mla-service/src/deployment/model_registry.py` — filesystem registry + RDA bridge.
- `mla-service/scripts/train_initial_model.py` — manual cold-start script (uses the **legacy** registry interface — prefer `python -m src.main --train`).
- `mla-service/scripts/train_with_datasets.py` — IEEE-CIS / PaySim loaders (same legacy-registry caveat).
- `mla-service/src/config.py` — every env var the service reads.
- `src/database/migrations/20240413000001_create_transactions_table.ts` — base `transactions` schema.
- `src/database/migrations/20260514000001_add_decision_source_to_transactions.ts` — `decisionSource` + `ruleName` columns and the `idx_transactions_ml_training` partial index.
- `src/shared/onnx/onnx.service.ts` — the schema-mismatch refusal lives here (`applyActiveVersion`, line ~196).
