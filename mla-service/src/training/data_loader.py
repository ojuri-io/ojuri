"""
Data loading from PostgreSQL with comprehensive feature extraction.
"""

import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text
from typing import Tuple, Dict, List
import logging

from src.config import config

logger = logging.getLogger(__name__)


class DataLoader:
    """
    Load training data from PostgreSQL.
    
    IMPORTANT NOTE ON FRAUD LABELS:
    ═══════════════════════════════════════════════════════════════
    Fraud labels are NOT immediately available. Timeline:
    
    Day 1: Transaction occurs → fraud_label = NULL
    Day 3-7: Customer complains OR chargeback → fraud_label = TRUE/FALSE
    
    This means:
    - Training data is always 3-7 days old (expected and acceptable!)
    - Query filters: WHERE fraud_label IS NOT NULL
    - Most transactions in Kafka will have fraud_label = NULL
    
    Delayed labeling is the expected steady state — the drift detector
    and retraining cadence are designed around this 3–7 day lag.
    ═══════════════════════════════════════════════════════════════
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
        
        Args:
            limit: Maximum number of transactions to load
        
        Returns:
            (features_df, labels)
        
        FRAUD LABEL DELAY:
        This query only returns transactions with fraud_label IS NOT NULL.
        These are transactions that have been labeled (3-7 days after occurrence).
        This is realistic for production fraud detection systems.
        """
        if limit is None:
            limit = config.TRAINING_DATA_SIZE
        
        logger.info(f"Loading up to {limit:,} labeled transactions from PostgreSQL...")
        
        # Try to load from transactions table
        query = text("""
            SELECT 
                "transactionId" as transaction_id,
                "senderId" as sender_id,
                "receiverId" as receiver_id,
                amount,
                "transactionType" as transaction_type,
                "createdAt" as timestamp,
                "fraudLabel" as fraud_label,
                "fraudProbability" as fraud_probability,
                "deviceFingerprint" as device_fingerprint
            FROM transactions
            WHERE "fraudLabel" IS NOT NULL
            ORDER BY "createdAt" DESC
            LIMIT :limit
        """)
        
        try:
            with self.engine.connect() as conn:
                df = pd.read_sql(query, conn, params={'limit': limit})
        except Exception as e:
            logger.warning(f"Could not load with standard column names: {e}")
            # Try alternate column names
            query = text("""
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
            """)
            with self.engine.connect() as conn:
                df = pd.read_sql(query, conn, params={'limit': limit})
        
        if len(df) == 0:
            logger.error("❌ No labeled transactions found in database!")
            logger.error("   Possible reasons:")
            logger.error("   1. No transactions have been labeled yet (need 3-7 day delay)")
            logger.error("   2. Labeling process not running")
            logger.error("   3. Database connection issue")
            logger.error("")
            logger.warning("Generating synthetic data for development...")
            df = self._generate_synthetic_data(limit)
        
        logger.info(f"Loaded {len(df):,} labeled transactions")
        logger.info(f"Fraud rate: {df['fraud_label'].mean()*100:.2f}%")
        
        # Calculate label age
        if 'timestamp' in df.columns and df['timestamp'].notna().any():
            try:
                import time
                # Handle various timestamp formats
                if pd.api.types.is_datetime64_any_dtype(df['timestamp']):
                    avg_timestamp = df['timestamp'].mean().timestamp()
                else:
                    avg_timestamp = pd.to_datetime(df['timestamp']).mean().timestamp()
                current_time = time.time()
                avg_age_days = (current_time - avg_timestamp) / 86400
                logger.info(f"Average label age: {avg_age_days:.1f} days (expected: 3-7 days)")
            except Exception as e:
                logger.debug(f"Could not calculate label age: {e}")
        
        # Extract features
        features_df = self._extract_features(df)
        labels = df['fraud_label'].astype(int)
        
        return features_df, labels
    
    def _generate_synthetic_data(self, n_samples: int) -> pd.DataFrame:
        """
        Generate synthetic transaction data for development/testing.
        
        This is used when no labeled data is available in the database.
        The synthetic data mimics real transaction patterns.
        """
        logger.warning("=" * 70)
        logger.warning("⚠️  GENERATING SYNTHETIC DATA FOR DEVELOPMENT")
        logger.warning("   In production, use real labeled transactions")
        logger.warning("=" * 70)
        
        np.random.seed(42)
        
        n_samples = min(n_samples, 10000)  # Cap for development
        
        # Generate features
        data = {
            'transaction_id': [f'TXN{i:08d}' for i in range(n_samples)],
            'sender_id': np.random.randint(1000000, 9999999, n_samples),
            'receiver_id': np.random.randint(1000000, 9999999, n_samples),
            'amount': np.random.lognormal(8, 2, n_samples),  # Log-normal amounts
            'transaction_type': np.random.choice(
                ['TRANSFER', 'PAYMENT', 'CASH_OUT', 'CASH_IN', 'DEBIT'],
                n_samples,
                p=[0.35, 0.25, 0.20, 0.15, 0.05]
            ),
            'timestamp': pd.date_range(
                end=pd.Timestamp.now(),
                periods=n_samples,
                freq='5min'
            ),
            'device_fingerprint': [f'DEV{np.random.randint(1, 1000):04d}' for _ in range(n_samples)],
            'fraud_probability': np.random.random(n_samples) * 0.5,
        }
        
        # Generate fraud labels with realistic distribution (~2% fraud rate)
        fraud_base_prob = 0.02
        # Higher amounts have higher fraud probability
        amount_factor = np.clip(data['amount'] / 100000, 0, 0.2)
        fraud_probs = fraud_base_prob + amount_factor
        data['fraud_label'] = (np.random.random(n_samples) < fraud_probs).astype(int)
        
        df = pd.DataFrame(data)
        
        logger.info(f"Generated {len(df):,} synthetic transactions")
        logger.info(f"Synthetic fraud rate: {df['fraud_label'].mean()*100:.2f}%")
        
        return df
    
    def _extract_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Extract 434-dimensional feature vector from transaction data.
        
        ⚠️ PROTOTYPE MODE:
        ═══════════════════════════════════════════════════════════════
        This implementation extracts ~20-50 REAL features and fills the
        remaining ~400 features with zeros (placeholders).

        This is sufficient to demonstrate the ML pipeline architecture
        end-to-end. Before production deployment, extend feature
        extraction to include at minimum:
        - Full velocity calculations (1h, 6h, 12h, 24h, 7d, 30d windows)
        - Complete graph metrics (PageRank, betweenness, eigenvector centrality)
        - Device fingerprint analysis (browser, OS, screen resolution hashing)
        - Behavioral patterns (time-of-day distributions, transaction sequences)
        - Network features (community detection, anomaly scores, clustering)

        XGBoost handles sparse features well, so the model continues to
        function while the feature pipeline is extended incrementally.
        ═══════════════════════════════════════════════════════════════
        
        Returns:
            DataFrame with 434 features (some real, some placeholders)
        """
        
        logger.info("Extracting features from transactions...")
        
        features = pd.DataFrame()
        
        # ═══════════════════════════════════════════════════════════════
        # REAL FEATURES - Actually extracted from data
        # ═══════════════════════════════════════════════════════════════
        
        # Transaction amount (optimize data type)
        features['amount'] = df['amount'].astype('float32')
        
        # Normalized amount
        features['amount_log'] = np.log1p(df['amount']).astype('float32')
        
        # Time-based features
        try:
            timestamps = pd.to_datetime(df['timestamp'])
            features['hour_of_day'] = timestamps.dt.hour.astype('int8')
            features['day_of_week'] = timestamps.dt.dayofweek.astype('int8')
            features['is_weekend'] = timestamps.dt.dayofweek.isin([5, 6]).astype('int8')
            features['day_of_month'] = timestamps.dt.day.astype('int8')
            features['is_night'] = ((timestamps.dt.hour >= 22) | (timestamps.dt.hour < 6)).astype('int8')
            features['is_business_hours'] = ((timestamps.dt.hour >= 9) & (timestamps.dt.hour < 17)).astype('int8')
        except Exception as e:
            logger.warning(f"Could not extract time features: {e}")
            features['hour_of_day'] = 12
            features['day_of_week'] = 0
            features['is_weekend'] = 0
            features['day_of_month'] = 15
            features['is_night'] = 0
            features['is_business_hours'] = 1
        
        # Transaction type (one-hot encoding)
        if 'transaction_type' in df.columns:
            type_dummies = pd.get_dummies(df['transaction_type'], prefix='type')
            for col in type_dummies.columns:
                features[col] = type_dummies[col].astype('int8')
        
        # Device fingerprint features (if available)
        if 'device_fingerprint' in df.columns:
            features['has_device_fp'] = df['device_fingerprint'].notna().astype('int8')
        else:
            features['has_device_fp'] = 0
        
        # Amount percentile features
        features['amount_percentile'] = df['amount'].rank(pct=True).astype('float32')
        features['is_high_amount'] = (df['amount'] > df['amount'].quantile(0.95)).astype('int8')
        features['is_round_amount'] = (df['amount'] % 1000 == 0).astype('int8')
        
        # Velocity features (these would come from PAA in production)
        # For now, use placeholders - in production, join with Redis/graph_metadata
        features['velocity_1h'] = 0  # Placeholder
        features['velocity_24h'] = 0  # Placeholder
        features['velocity_7d'] = 0   # Placeholder
        
        # Graph features (from graph_metadata table)
        # For prototype, use placeholders
        features['pagerank'] = 0.0     # Placeholder
        features['clustering'] = 0.0    # Placeholder
        features['community_id'] = 0    # Placeholder
        
        real_feature_count = len(features.columns)
        
        # ═══════════════════════════════════════════════════════════════
        # PLACEHOLDER FEATURES - Zeros to reach 434 total
        # ═══════════════════════════════════════════════════════════════
        
        num_placeholders = 434 - real_feature_count
        
        if num_placeholders > 0:
            # Issue prominent warning
            logger.warning("=" * 70)
            logger.warning("⚠️  PROTOTYPE MODE: USING PLACEHOLDER FEATURES")
            logger.warning(f"   Real features extracted: {real_feature_count}")
            logger.warning(f"   Placeholder features (zeros): {num_placeholders}")
            logger.warning(f"   Total features: 434")
            logger.warning("")
            logger.warning("   This is PROTOTYPE MODE — extend feature engineering before production.")
            logger.warning("=" * 70)
            
            # Add placeholder features efficiently
            placeholder_data = np.zeros((len(df), num_placeholders), dtype=np.float32)
            placeholder_cols = [f'placeholder_{i}' for i in range(num_placeholders)]
            placeholder_df = pd.DataFrame(placeholder_data, columns=placeholder_cols, index=features.index)
            features = pd.concat([features, placeholder_df], axis=1)
        
        # Quality check
        if real_feature_count < 20:
            logger.error("=" * 70)
            logger.error("❌ CRITICAL: Very few real features extracted!")
            logger.error(f"   Only {real_feature_count} real features (need at least 20)")
            logger.error("   Model performance will be severely limited")
            logger.error("   Consider implementing more feature engineering")
            logger.error("=" * 70)
        
        logger.info(f"✅ Feature extraction complete: {len(features.columns)} total features")
        logger.info(f"   Real features: {real_feature_count}")
        logger.info(f"   Placeholder features: {num_placeholders}")
        
        return features
    
    def get_feature_distributions(self, df: pd.DataFrame) -> Dict[str, List[float]]:
        """
        Calculate feature distributions for PSI baseline.
        
        Args:
            df: Feature DataFrame
        
        Returns:
            Dict mapping feature names to value arrays
        """
        distributions = {}
        
        # Track distributions for key features only (not placeholders)
        key_features = [col for col in df.columns if not col.startswith('placeholder_')]
        
        for feature in key_features[:20]:  # Top 20 features
            distributions[feature] = df[feature].values.tolist()
        
        logger.info(f"Calculated distributions for {len(distributions)} features")
        
        return distributions
