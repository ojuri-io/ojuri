"""
Data loading from PostgreSQL with catalogue-driven feature extraction.

The previous revision of this file hand-extracted ~20 real features
and zero-padded the rest to reach a hardcoded 434 columns. That
contract was implicit and drifted away from RDA's serving-time
enrichment — the train/serve skew this whole catalogue effort exists
to fix.

The feature matrix is now built directly from the catalogue at
`models/feature-catalog.v1.json` (+ optional adopter overlay). Every
column has a known catalogue index, name, and default. PAA-derived
features (velocity, graph) are joined from the `graphMetadata` and
`velocitySnapshots` tables PAA persists. Request-time features that
aren't in the `transactions` schema take the catalogue's per-feature
default — that's the honest signal until adopters extend the
`transactions` schema with the columns they care about.
"""

import logging
import time
from typing import Callable, Dict, List, Tuple

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text

from src.config import config
from src.features.catalog import load_catalog, FeatureSpec

logger = logging.getLogger(__name__)


class DataLoader:
    """
    Load training data from PostgreSQL.

    Labels are filtered down to ML-driven rows
    (`decisionSource = 'ML'` or NULL) so rule-driven DECLINEs don't
    leak into the training set as positives. The drift detector + the
    `--train` cold-start path both go through `load_training_data`.
    """

    def __init__(self):
        connection_string = (
            f"postgresql://{config.POSTGRES_USER}:{config.POSTGRES_PASSWORD}@"
            f"{config.POSTGRES_HOST}:{config.POSTGRES_PORT}/{config.POSTGRES_DB}"
        )
        self.engine = create_engine(connection_string)
        logger.info("DataLoader initialized")

    def load_training_data(self, limit: int = None) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load recent LABELED transactions from PostgreSQL.

        Returns the feature DataFrame in catalogue order plus the
        fraud-label Series.
        """
        if limit is None:
            limit = config.TRAINING_DATA_SIZE

        logger.info("Loading up to %d labeled transactions from PostgreSQL...", limit)

        # Label resolution order:
        #
        #   1. `groundTruthFraud` — verified by reviewer override or
        #      chargeback. The highest-quality signal we have. Used
        #      with `COALESCE` so when present it always wins.
        #   2. `fraudLabel` — the system's own DECLINE outcome, kept
        #      as a fallback for rows that haven't been reviewed yet.
        #      Still filtered to ML-driven rows so rule-driven
        #      DECLINEs don't pollute the training set (see
        #      `docs/AUDIT.md`).
        #
        # `ORDER BY "groundTruthFraud" IS NOT NULL DESC, "createdAt"
        # DESC` puts the verified rows first within `limit`, so when
        # the table gets big the model trains on real ground truth
        # before falling back to system labels.
        query = text(
            """
            SELECT
                "transactionId" as transaction_id,
                "senderId" as sender_id,
                "receiverId" as receiver_id,
                amount,
                "transactionType" as transaction_type,
                "createdAt" as timestamp,
                COALESCE("groundTruthFraud", "fraudLabel") as fraud_label,
                "groundTruthFraud" IS NOT NULL as is_ground_truth,
                "fraudProbability" as fraud_probability,
                "deviceFingerprint" as device_fingerprint
            FROM transactions
            WHERE COALESCE("groundTruthFraud", "fraudLabel") IS NOT NULL
              AND ("decisionSource" IS NULL OR "decisionSource" = 'ML')
            ORDER BY "groundTruthFraud" IS NOT NULL DESC, "createdAt" DESC
            LIMIT :limit
            """
        )

        try:
            with self.engine.connect() as conn:
                df = pd.read_sql(query, conn, params={"limit": limit})
        except Exception as e:
            logger.warning("Could not load with standard column names: %s", e)
            query = text(
                """
                SELECT
                    transaction_id,
                    sender_id,
                    receiver_id,
                    amount,
                    transaction_type,
                    timestamp,
                    fraud_label,
                    fraud_probability,
                    device_fingerprint
                FROM transactions
                WHERE fraud_label IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT :limit
                """
            )
            with self.engine.connect() as conn:
                df = pd.read_sql(query, conn, params={"limit": limit})

        if len(df) == 0:
            logger.error("❌ No labeled transactions found in database!")
            logger.warning("Generating synthetic data for development...")
            df = self._generate_synthetic_data(limit)

        logger.info("Loaded %d labeled transactions", len(df))
        logger.info("Fraud rate: %.2f%%", df["fraud_label"].mean() * 100)
        if "is_ground_truth" in df.columns:
            ground_truth_count = int(df["is_ground_truth"].sum())
            logger.info(
                "Ground-truth coverage: %d / %d rows (%.1f%%) — the rest fall back to system fraudLabel",
                ground_truth_count,
                len(df),
                100 * ground_truth_count / max(len(df), 1),
            )

        if "timestamp" in df.columns and df["timestamp"].notna().any():
            try:
                if pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
                    avg_timestamp = df["timestamp"].mean().timestamp()
                else:
                    avg_timestamp = pd.to_datetime(df["timestamp"]).mean().timestamp()
                avg_age_days = (time.time() - avg_timestamp) / 86400
                logger.info("Average label age: %.1f days (expected: 3-7 days)", avg_age_days)
            except Exception as e:
                logger.debug("Could not calculate label age: %s", e)

        features_df = self._extract_features(df)
        labels = df["fraud_label"].astype(int)

        return features_df, labels

    def _generate_synthetic_data(self, n_samples: int) -> pd.DataFrame:
        """Synthetic transactions for cold-start when nothing's in the DB."""
        logger.warning("=" * 70)
        logger.warning("⚠️  GENERATING SYNTHETIC DATA FOR DEVELOPMENT")
        logger.warning("   In production, use real labeled transactions")
        logger.warning("=" * 70)

        np.random.seed(42)
        n_samples = min(n_samples, 10000)

        data = {
            "transaction_id": [f"TXN{i:08d}" for i in range(n_samples)],
            "sender_id": np.random.randint(1000000, 9999999, n_samples),
            "receiver_id": np.random.randint(1000000, 9999999, n_samples),
            "amount": np.random.lognormal(8, 2, n_samples),
            "transaction_type": np.random.choice(
                ["TRANSFER", "PAYMENT", "CASH_OUT", "CASH_IN", "DEBIT"],
                n_samples,
                p=[0.35, 0.25, 0.20, 0.15, 0.05],
            ),
            "timestamp": pd.date_range(end=pd.Timestamp.now(), periods=n_samples, freq="5min"),
            "device_fingerprint": [
                f"DEV{np.random.randint(1, 1000):04d}" for _ in range(n_samples)
            ],
            "fraud_probability": np.random.random(n_samples) * 0.5,
        }

        fraud_base_prob = 0.02
        amount_factor = np.clip(data["amount"] / 100000, 0, 0.2)
        fraud_probs = fraud_base_prob + amount_factor
        data["fraud_label"] = (np.random.random(n_samples) < fraud_probs).astype(int)

        df = pd.DataFrame(data)
        logger.info("Generated %d synthetic transactions", len(df))
        return df

    # ────────────────────────────────────────────────────────────
    # Catalogue-driven feature extraction
    # ────────────────────────────────────────────────────────────
    def _extract_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Build the training feature matrix from the catalogue.

        - **`paa:redis` features** — joined from `graphMetadata` and
          `velocitySnapshots` when rows exist for the same sender;
          today covers velocity_1h/24h/7d and graph_pagerank /
          clustering_coef / community_id / in_degree / out_degree.
        - **`rda:request` features** — from the `transactions` row
          when the column exists; default otherwise.
        - **`rda:derived` features** — computed from the row
          (hour_of_day, day_of_week, is_weekend, is_payday_window,
          is_off_hours, transaction_type_code, is_inflow).
        - **adopter overlay features** — default at training time;
          adopters who care about a specific overlay feature need
          the corresponding column in `transactions` to produce
          useful values offline.

        Columns are emitted in catalogue index order so downstream
        code can index by position safely.
        """
        catalog = load_catalog()
        logger.info(
            "Catalogue-driven feature extraction (schema=%s, dim=%d, rows=%d)",
            catalog.schema_version, catalog.input_dimension, len(df),
        )

        sender_ids: List[str] = (
            df["sender_id"].astype(str).unique().tolist() if "sender_id" in df.columns else []
        )
        paa_snapshots = self._load_paa_snapshots(sender_ids)

        columns: Dict[str, np.ndarray] = {}
        for spec in catalog.features:
            columns[spec.name] = self._materialise_column(spec, df, paa_snapshots)

        feature_df = pd.DataFrame({spec.name: columns[spec.name] for spec in catalog.features})
        logger.info("✅ Feature extraction complete: %d columns", len(feature_df.columns))
        return feature_df

    def _load_paa_snapshots(self, sender_ids: List[str]) -> Dict[str, Dict[str, float]]:
        """
        Pull the most recent persisted feature snapshot per sender
        from PAA's tables. Returns `{sender_id → {feature_name →
        value}}`. Empty when neither table has rows or the query
        fails — training proceeds with catalogue defaults for those
        slots.
        """
        if not sender_ids:
            return {}

        snapshots: Dict[str, Dict[str, float]] = {}

        # Velocity windows
        try:
            with self.engine.connect() as conn:
                vq = text(
                    """
                    SELECT DISTINCT ON ("userId")
                        "userId" AS sender_id,
                        "velocity1h" AS velocity_1h,
                        "velocity24h" AS velocity_24h,
                        "velocity7d" AS velocity_7d
                    FROM "velocitySnapshots"
                    WHERE "userId" = ANY (:ids)
                    ORDER BY "userId", "createdAt" DESC
                    """
                )
                for row in conn.execute(vq, {"ids": sender_ids}).mappings():
                    snapshots.setdefault(str(row["sender_id"]), {}).update(
                        {
                            "velocity_1h": float(row["velocity_1h"] or 0),
                            "velocity_24h": float(row["velocity_24h"] or 0),
                            "velocity_7d": float(row["velocity_7d"] or 0),
                        }
                    )
        except Exception as e:
            logger.debug("velocitySnapshots unavailable, defaulting velocity_* slots: %s", e)

        # Graph metrics
        try:
            with self.engine.connect() as conn:
                gq = text(
                    """
                    SELECT DISTINCT ON ("userId")
                        "userId" AS sender_id,
                        "pageRankScore" AS graph_pagerank,
                        "clusteringCoefficient" AS graph_clustering_coef,
                        "communityId" AS graph_community_id,
                        "inDegree" AS graph_in_degree,
                        "outDegree" AS graph_out_degree
                    FROM "graphMetadata"
                    WHERE "userId" = ANY (:ids)
                    ORDER BY "userId", "createdAt" DESC
                    """
                )
                for row in conn.execute(gq, {"ids": sender_ids}).mappings():
                    snapshots.setdefault(str(row["sender_id"]), {}).update(
                        {
                            "graph_pagerank": float(row["graph_pagerank"] or 0),
                            "graph_clustering_coef": float(row["graph_clustering_coef"] or 0),
                            "graph_community_id": float(row["graph_community_id"] or 0),
                            "graph_in_degree": float(row["graph_in_degree"] or 0),
                            "graph_out_degree": float(row["graph_out_degree"] or 0),
                        }
                    )
        except Exception as e:
            logger.debug("graphMetadata unavailable, defaulting graph_* slots: %s", e)

        return snapshots

    def _materialise_column(
        self,
        spec: FeatureSpec,
        df: pd.DataFrame,
        paa_snapshots: Dict[str, Dict[str, float]],
    ) -> np.ndarray:
        """
        Produce the column values for a single catalogue feature
        across `df`'s rows. Always returns a fixed-dtype np.ndarray
        of length `len(df)`.
        """
        n = len(df)
        if isinstance(spec.default, bool):
            default_value = 1.0 if spec.default else 0.0
        else:
            default_value = float(spec.default)

        if spec.source == "paa:redis":
            if "sender_id" not in df.columns:
                return np.full(n, default_value, dtype=np.float32)
            ids = df["sender_id"].astype(str).values
            return np.fromiter(
                (paa_snapshots.get(sid, {}).get(spec.name, default_value) for sid in ids),
                dtype=np.float32,
                count=n,
            )

        if spec.name == "amount":
            return df["amount"].astype("float32").values

        if spec.name == "hour_of_day":
            return self._safe_time_field(df, lambda ts: ts.dt.hour, default_value)
        if spec.name == "day_of_week":
            return self._safe_time_field(df, lambda ts: ts.dt.dayofweek, default_value)
        if spec.name == "is_weekend":
            return self._safe_time_field(
                df, lambda ts: ts.dt.dayofweek.isin([5, 6]).astype("int8"), default_value
            )
        if spec.name == "is_payday_window":
            return self._safe_time_field(
                df, lambda ts: ts.dt.day.isin(list(range(23, 32))).astype("int8"), default_value
            )
        if spec.name == "is_off_hours":
            return self._safe_time_field(
                df,
                lambda ts: ((ts.dt.hour <= 5) | (ts.dt.hour == 23)).astype("int8"),
                default_value,
            )
        if spec.name == "transaction_type_code":
            return self._encode_transaction_type(df).astype("float32")
        if spec.name == "is_inflow":
            if "transaction_type" not in df.columns:
                return np.full(n, default_value, dtype=np.float32)
            return (
                df["transaction_type"].astype(str).str.upper() == "CASH_IN"
            ).astype("float32").values

        if spec.name in df.columns:
            return (
                pd.to_numeric(df[spec.name], errors="coerce")
                .fillna(default_value)
                .astype("float32")
                .values
            )

        return np.full(n, default_value, dtype=np.float32)

    def _safe_time_field(
        self,
        df: pd.DataFrame,
        extract: Callable[[pd.Series], pd.Series],
        default_value: float,
    ) -> np.ndarray:
        """Apply a `dt.*` extractor with NaN tolerance — fall back to default on any error."""
        try:
            ts = pd.to_datetime(df["timestamp"])
            return extract(ts).astype("float32").values
        except Exception as e:
            logger.debug("Could not compute time field: %s — using default %s", e, default_value)
            return np.full(len(df), default_value, dtype=np.float32)

    # Catalogue contract — keep in sync with `encodeTransactionType`
    # in `src/shared/features/encoders.ts`. Bumping these requires a
    # catalogue version bump.
    _TXN_TYPE_CODES = {
        "": 0,
        "CASH_IN": 1,
        "CASH_OUT": 2,
        "PAYMENT": 3,
        "TRANSFER": 4,
        "DEBIT": 5,
        "PAYOUT": 6,
        "WITHDRAWAL": 7,
    }

    def _encode_transaction_type(self, df: pd.DataFrame) -> np.ndarray:
        if "transaction_type" not in df.columns:
            return np.zeros(len(df), dtype=np.float32)
        return (
            df["transaction_type"]
            .astype(str)
            .str.upper()
            .map(self._TXN_TYPE_CODES)
            .fillna(0)
            .values
        )

    def get_feature_distributions(self, df: pd.DataFrame) -> Dict[str, List[float]]:
        """
        Calculate feature distributions for PSI baseline.

        Returns a dict mapping catalogue feature names → value arrays
        for the features that actually have variance in this batch.
        Constant columns (everything at catalogue default) are skipped
        because PSI is undefined on a single-value distribution.
        """
        distributions: Dict[str, List[float]] = {}
        for col in df.columns:
            values = df[col].values
            if pd.Series(values).nunique(dropna=False) > 1:
                distributions[col] = values.tolist()
        logger.info("Calculated distributions for %d features", len(distributions))
        return distributions
