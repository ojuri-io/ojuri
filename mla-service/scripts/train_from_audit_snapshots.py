"""
Train a fraud model on `decisionAuditLog.featuresSnapshot` (the actual
64-dim feature vector RDA saw at predict time, including any PAA
enrichment) joined with `transactions.fraudLabel` (the ground truth).

This closes the loop that ingest_paysim.py + train_initial_model.py
leaves open: the existing trainer reads raw columns from the
transactions table, runs feature extraction on them, and so always
sees PAA fields defaulted. A trainer that reads the captured snapshot
instead sees exactly what RDA serves at inference — eliminating
train/serve skew on the PAA-derived positions.

Pre-req: replay_paysim_through_rda.py has been run twice (once cold to
let PAA accumulate state, once warm so the audit log captures
Redis-populated features). The audit log must hold rows whose
transactionIds JOIN to PaySim-labelled rows in the transactions table.

Run:
  cd mla-service && source venv/bin/activate
  python scripts/train_from_audit_snapshots.py
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import psycopg2
import xgboost as xgb
from sklearn.metrics import classification_report, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split

# Use the existing ONNX converter so the output is drop-in compatible
# with the rest of the pipeline (registry, OnnxService).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from src.deployment.onnx_converter import ONNXConverter  # noqa: E402


def _load_catalogue_order():
    """
    Load feature names in catalogue order (matches RDA's feature-builder
    output positions). Alphabetical ordering is WRONG — RDA emits the
    vector in catalogue index order, so a model trained on alphabetically
    sorted columns will see "amount" at position 2 but RDA puts it at
    position 26 — same numbers at different positions → model output
    uncorrelated with training labels at inference.
    """
    import json
    from pathlib import Path
    catalog_path = (
        Path(__file__).resolve().parent.parent.parent / "models" / "feature-catalog.v1.json"
    )
    with catalog_path.open() as f:
        cat = json.load(f)
    return [f["name"] for f in cat["features"]]


def fetch_training_data(args):
    """
    SELECT featuresSnapshot, fraudLabel from audit JOIN transactions.
    Returns (X, y, feature_names) where X is a (N, 64) float32 array
    in catalogue order (the same order RDA serves at inference).
    """
    conn = psycopg2.connect(
        host=args.host, port=args.port, dbname=args.db, user=args.user, password=args.password
    )
    cur = conn.cursor()
    # Restrict to PaySim-seeded rows only — the harness's audit rows
    # also write a transactions entry with the model decision *as* the
    # fraudLabel, which is not ground truth and would poison training.
    # PaySim rows are the only ones whose fraudLabel comes from the
    # source CSV's `isFraud` column.
    cur.execute(
        """
        SELECT a."featuresSnapshot", t."fraudLabel"
        FROM "decisionAuditLog" a
        JOIN transactions t ON a."transactionId" = t."transactionId"
        WHERE t."fraudLabel" IS NOT NULL
          AND a."featuresSnapshot" IS NOT NULL
          AND a."transactionId" LIKE 'paysim-%%'
        """
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()

    if not rows:
        sys.exit("No audit rows with matching fraudLabel found. Did replay run?")

    catalog_order = _load_catalogue_order()
    snapshot_keys = set(rows[0][0].keys())
    # Sanity-check that every catalogue feature is present in the audit
    # snapshot — a missing key means RDA's feature-builder dropped a
    # column the model trained against, which is silently dangerous.
    missing = [n for n in catalog_order if n not in snapshot_keys]
    extra = [k for k in snapshot_keys if k not in catalog_order]
    if missing:
        print(f"WARN: catalogue features missing from audit snapshot: {missing}")
    if extra:
        print(f"INFO: audit snapshot has extra keys not in catalogue: {extra}")

    print(f"Found {len(rows)} labelled audit rows")
    print(f"Feature columns ({len(catalog_order)} in catalogue order): {catalog_order[:5]} … {catalog_order[-3:]}")

    X = np.zeros((len(rows), len(catalog_order)), dtype=np.float32)
    y = np.zeros(len(rows), dtype=np.int8)
    for i, (snapshot, label) in enumerate(rows):
        for j, k in enumerate(catalog_order):
            v = snapshot.get(k, 0)
            X[i, j] = float(v) if v is not None and not isinstance(v, bool) else (1.0 if v is True else 0.0)
        y[i] = 1 if label else 0

    return X, y, catalog_order


PAA_FEATURE_PREFIXES = (
    "velocity_",
    "amount_mean_",
    "amount_std_",
    "amount_max_",
    "amount_zscore",
    "graph_",
    "pair_",
    "unique_receivers_",
    "recipient_dispute_",
    "recipient_lifetime_",
    "hour_dev_from_sender",
)

# Catalogue-default values for PAA-derived positions. Matches
# DEFAULT_REDIS_SNAPSHOT in src/v1/modules/rda/services/feature.service.ts
# (any field not listed defaults to 0 in the feature builder).
PAA_DEFAULTS = {
    "velocity_1h": 2.5,
    "velocity_24h": 15,
    "velocity_7d": 75,
    "amount_mean_30d": 25000.0,
    "amount_std_30d": 15000.0,
    "graph_pagerank": 0.15,
    "graph_clustering_coef": 0.35,
    "graph_shortest_path_to_fraud": 99.0,
    "pair_time_since_last_send": 3600.0,
}


def is_paa_feature(name: str) -> bool:
    return any(name.startswith(p) for p in PAA_FEATURE_PREFIXES)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default=os.getenv("POSTGRES_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.getenv("POSTGRES_PORT", "5433")))
    p.add_argument("--db", default=os.getenv("POSTGRES_DB", "fraud_db"))
    p.add_argument("--user", default=os.getenv("POSTGRES_USER", "postgres"))
    p.add_argument("--password", default=os.getenv("POSTGRES_PASSWORD", "postgres"))
    p.add_argument("--out", default="./models/fraud_model_v1.0.onnx")
    p.add_argument(
        "--paa-dropout-rate",
        type=float,
        default=0.0,
        help="Probability that a training row has its PAA-derived feature "
        "columns replaced with catalogue defaults. Lets the model learn "
        "to fall back to request-level fields on Redis cold-cache.",
    )
    args = p.parse_args()

    X, y, feature_names = fetch_training_data(args)
    print(f"Class distribution: legit={int((y==0).sum())} fraud={int((y==1).sum())} rate={float(y.mean()):.4%}")

    # PAA-feature dropout: replace PAA-sourced columns with their
    # catalogue defaults for a random subset of rows. Mirrors what RDA
    # serves at inference when Redis returns a miss for a brand-new
    # sender — without this the model never sees that distribution.
    if args.paa_dropout_rate > 0:
        paa_cols = [i for i, n in enumerate(feature_names) if is_paa_feature(n)]
        rng = np.random.default_rng(42)
        mask = rng.random(len(X)) < args.paa_dropout_rate
        for i in paa_cols:
            name = feature_names[i]
            X[mask, i] = PAA_DEFAULTS.get(name, 0.0)
        print(f"Applied PAA-feature dropout to {int(mask.sum())} rows ({len(paa_cols)} PAA cols)")

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    print(f"Train: {len(X_train)}  Test: {len(X_test)}")

    pos = float((y_train == 1).sum())
    neg = float((y_train == 0).sum())
    scale_pos_weight = neg / pos if pos > 0 else 1.0
    print(f"scale_pos_weight = {scale_pos_weight:.2f}")

    model = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        objective="binary:logistic",
        eval_metric="auc",
        tree_method="hist",
        scale_pos_weight=scale_pos_weight,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]
    pred = (proba >= 0.5).astype(int)
    print()
    print(f"F1-score:  {f1_score(y_test, pred):.4f}")
    print(f"AUC-ROC:   {roc_auc_score(y_test, proba):.4f}")
    print(f"Precision: {precision_score(y_test, pred, zero_division=0):.4f}")
    print(f"Recall:    {recall_score(y_test, pred, zero_division=0):.4f}")
    print()
    print(classification_report(y_test, pred, digits=4))

    # Top features
    importances = sorted(zip(feature_names, model.feature_importances_), key=lambda kv: -kv[1])
    print("\nTop 15 features:")
    for name, imp in importances[:15]:
        print(f"  {name:30s}  {imp:.4f}")

    # Convert to ONNX via the existing converter for compatibility.
    # The converter expects a StandardScaler — we don't need one (XGBoost
    # tree-based, RDA doesn't apply scaler at inference) so pass an
    # already-fitted identity scaler (with_mean=False, with_std=False).
    from sklearn.preprocessing import StandardScaler
    identity_scaler = StandardScaler(with_mean=False, with_std=False)
    identity_scaler.fit(X_train)
    converter = ONNXConverter()
    converter.convert_to_onnx(
        model=model,
        scaler=identity_scaler,
        output_path=args.out,
        num_features=len(feature_names),
    )
    print(f"\n✅ ONNX model saved: {args.out}")

    # Stamp a tiny metadata file alongside so anyone deploying knows
    # this artefact was produced from audit-snapshot training.
    meta_path = args.out.replace(".onnx", "_metadata.json")
    with open(meta_path, "w") as f:
        json.dump(
            {
                "version": "v1.0",
                "training_source": "decisionAuditLog.featuresSnapshot (option 2)",
                "training_rows": len(X),
                "feature_input_dimension": len(feature_names),
                "feature_schema_version": "v1",
                "f1_score": float(f1_score(y_test, pred)),
                "auc_roc": float(roc_auc_score(y_test, proba)),
                "precision": float(precision_score(y_test, pred, zero_division=0)),
                "recall": float(recall_score(y_test, pred, zero_division=0)),
                "top_features": [(n, float(i)) for n, i in importances[:15]],
                "uploaded_at": datetime.now(tz=timezone.utc).isoformat(),
            },
            f,
            indent=2,
        )
    print(f"   Metadata: {meta_path}")


if __name__ == "__main__":
    main()
