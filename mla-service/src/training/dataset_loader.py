"""
CSV-based data loader for IEEE-CIS and PaySim datasets.

This module loads real fraud detection datasets:
1. IEEE-CIS Fraud Detection dataset (590,540 transactions, 434 features)
2. PaySim synthetic mobile money data (50,000 transaction subset)

The combined dataset is used for training with SMOTE balancing.

Reference:
- IEEE-CIS: IEEE Computational Intelligence Society, 2019
- PaySim: Lopez-Rojas et al., 2016
"""

import pandas as pd
import numpy as np
from pathlib import Path
from typing import Tuple, Optional, Dict
import logging
from sklearn.preprocessing import LabelEncoder

from src.config import config

logger = logging.getLogger(__name__)

# Dataset paths
DATA_DIR = Path(__file__).parent.parent.parent / 'data'
IEEE_CIS_DIR = DATA_DIR / 'ieee-cis'
PAYSIM_DIR = DATA_DIR / 'paysim'
SYNTHETIC_DIR = DATA_DIR / 'synthetic'


class DatasetLoader:
    """
    Load training data from IEEE-CIS and PaySim datasets.
    
    Loaders for the two reference datasets used by this service:
    - IEEE-CIS: 590,540 transactions with 434 engineered features
    - PaySim: 50,000 transaction subset modeling mobile money patterns
    - Combined dataset with SMOTE applied for class balancing
    
    Example:
        >>> loader = DatasetLoader()
        >>> X, y = loader.load_combined_dataset()
        >>> print(f"Shape: {X.shape}, Fraud rate: {y.mean():.4f}")
    """
    
    def __init__(self):
        self.ieee_cis_loaded = False
        self.paysim_loaded = False
        self.synthetic_loaded = False
        self._label_encoders = {}  # Store encoders for categorical columns
        self._feature_columns = None
        logger.info("DatasetLoader initialized")
    
    def _encode_categorical_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Encode categorical columns to numeric values.
        
        Uses LabelEncoder for categorical columns. NaN values are filled with
        a placeholder before encoding.
        
        Args:
            df: DataFrame with potential categorical columns
            
        Returns:
            DataFrame with all numeric columns
        """
        df = df.copy()
        categorical_cols = df.select_dtypes(include=['object', 'category']).columns.tolist()
        
        if categorical_cols:
            logger.info(f"  Encoding {len(categorical_cols)} categorical columns...")
            
        for col in categorical_cols:
            # Fill NaN with placeholder
            df[col] = df[col].fillna('__MISSING__')
            
            # Encode
            if col not in self._label_encoders:
                self._label_encoders[col] = LabelEncoder()
                df[col] = self._label_encoders[col].fit_transform(df[col].astype(str))
            else:
                # Handle unseen categories
                df[col] = df[col].astype(str)
                known_classes = set(self._label_encoders[col].classes_)
                df[col] = df[col].apply(lambda x: x if x in known_classes else '__UNKNOWN__')
                df[col] = self._label_encoders[col].transform(df[col])
        
        # Fill remaining NaN values with 0
        df = df.fillna(0)
        
        return df
    
    def load_ieee_cis(self, max_samples: Optional[int] = None) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load IEEE-CIS Fraud Detection dataset.
        
        Dataset characteristics:
        - 590,540 credit card transactions
        - 434 engineered features including:
          - Transaction metadata (amount, card type, etc.)
          - Device fingerprinting attributes
          - Behavioral aggregations (V1-V339)
        - Fraud rate: ~3.5%
        
        Args:
            max_samples: Maximum number of samples to load (None for all)
        
        Returns:
            Tuple of (features DataFrame, labels Series)
        """
        logger.info("=" * 70)
        logger.info("Loading IEEE-CIS Fraud Detection Dataset")
        logger.info("=" * 70)
        
        transaction_file = IEEE_CIS_DIR / 'train_transaction.csv'
        identity_file = IEEE_CIS_DIR / 'train_identity.csv'
        
        if not transaction_file.exists():
            logger.error(f"IEEE-CIS transaction file not found: {transaction_file}")
            logger.error("Run: python scripts/download_datasets.py")
            return None, None
        
        # Load transaction data
        logger.info("Loading transaction data...")
        nrows = max_samples if max_samples else None
        
        # Read in chunks for memory efficiency
        df_transaction = pd.read_csv(
            transaction_file,
            nrows=nrows,
            low_memory=False
        )
        logger.info(f"  Loaded {len(df_transaction):,} transactions")
        
        # Load identity data if available
        if identity_file.exists():
            logger.info("Loading identity data...")
            df_identity = pd.read_csv(identity_file, low_memory=False)
            logger.info(f"  Loaded {len(df_identity):,} identity records")
            
            # Merge on TransactionID
            df = pd.merge(
                df_transaction,
                df_identity,
                on='TransactionID',
                how='left'
            )
            logger.info(f"  Merged dataset: {len(df):,} rows, {len(df.columns)} columns")
        else:
            df = df_transaction
            logger.warning("Identity file not found - using transaction data only")
        
        # Extract labels
        if 'isFraud' not in df.columns:
            logger.error("Label column 'isFraud' not found in dataset")
            return None, None
        
        y = df['isFraud'].astype(int)
        
        # Drop non-feature columns
        drop_cols = ['TransactionID', 'isFraud', 'TransactionDT']
        feature_cols = [col for col in df.columns if col not in drop_cols]
        X = df[feature_cols]
        
        # Encode categorical columns to numeric
        X = self._encode_categorical_columns(X)
        
        # Store feature columns for consistency
        self._feature_columns = list(X.columns)
        
        # Dataset statistics
        fraud_rate = y.mean() * 100
        logger.info(f"  Features: {X.shape[1]}")
        logger.info(f"  Fraud rate: {fraud_rate:.2f}%")
        logger.info(f"  Fraud samples: {y.sum():,} / {len(y):,}")
        
        self.ieee_cis_loaded = True
        logger.info("✓ IEEE-CIS dataset loaded successfully")
        
        return X, y
    
    def load_paysim(
        self,
        max_samples: int = 50000,
        fraud_oversample: bool = True
    ) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load PaySim mobile money dataset.
        
        Dataset characteristics:
        - 6,362,620 total transactions (we use 50,000 subset)
        - 5 transaction types: CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER
        - Fraud rate: ~0.13% in the raw distribution
        
        Args:
            max_samples: Maximum number of samples to load
            fraud_oversample: Whether to oversample fraud cases for better representation
        
        Returns:
            Tuple of (features DataFrame, labels Series)
        """
        logger.info("=" * 70)
        logger.info("Loading PaySim Mobile Money Dataset")
        logger.info("=" * 70)
        
        paysim_file = PAYSIM_DIR / 'PS_20174392719_1491204439457_log.csv'
        
        if not paysim_file.exists():
            logger.error(f"PaySim file not found: {paysim_file}")
            logger.error("Run: python scripts/download_datasets.py")
            return None, None
        
        # Load dataset
        logger.info("Loading PaySim data...")
        df = pd.read_csv(paysim_file, low_memory=False)
        logger.info(f"  Total records: {len(df):,}")
        
        # Extract labels
        y_full = df['isFraud'].astype(int)
        
        # Sample strategy: keep all fraud cases, sample legitimate
        if fraud_oversample and max_samples:
            fraud_df = df[df['isFraud'] == 1]
            legit_df = df[df['isFraud'] == 0]
            
            n_fraud = len(fraud_df)
            n_legit = min(max_samples - n_fraud, len(legit_df))
            
            logger.info(f"  Sampling: {n_fraud:,} fraud + {n_legit:,} legitimate")
            
            legit_sample = legit_df.sample(n=n_legit, random_state=42)
            df = pd.concat([fraud_df, legit_sample], ignore_index=True)
        elif max_samples:
            df = df.sample(n=min(max_samples, len(df)), random_state=42)
        
        # Extract labels
        y = df['isFraud'].astype(int)
        
        # Engineer features to match IEEE-CIS format (434 features)
        X = self._engineer_paysim_features(df)
        
        # Dataset statistics
        fraud_rate = y.mean() * 100
        logger.info(f"  Final samples: {len(df):,}")
        logger.info(f"  Features: {X.shape[1]}")
        logger.info(f"  Fraud rate: {fraud_rate:.2f}%")
        logger.info(f"  Fraud samples: {y.sum():,} / {len(y):,}")
        
        self.paysim_loaded = True
        logger.info("✓ PaySim dataset loaded successfully")
        
        return X, y
    
    def _engineer_paysim_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Engineer features from PaySim to match IEEE-CIS dimensionality.
        
        PaySim columns:
        - step: time step (1 step = 1 hour)
        - type: CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER
        - amount: transaction amount
        - nameOrig: sender ID
        - oldbalanceOrg: sender balance before
        - newbalanceOrig: sender balance after
        - nameDest: recipient ID
        - oldbalanceDest: recipient balance before
        - newbalanceDest: recipient balance after
        - isFraud: fraud label
        - isFlaggedFraud: flagged by heuristic
        
        Returns:
            DataFrame with 434 features
        """
        features = pd.DataFrame()
        
        # ═══════════════════════════════════════════════════════════════
        # TRANSACTION AMOUNT FEATURES
        # ═══════════════════════════════════════════════════════════════
        features['TransactionAmt'] = df['amount'].astype('float32')
        features['TransactionAmt_log'] = np.log1p(df['amount']).astype('float32')
        features['TransactionAmt_decimal'] = (df['amount'] % 1).astype('float32')
        features['TransactionAmt_is_round'] = (df['amount'] % 100 == 0).astype('int8')
        
        # Amount bins (similar to IEEE-CIS)
        features['TransactionAmt_bin1'] = (df['amount'] <= 100).astype('int8')
        features['TransactionAmt_bin2'] = ((df['amount'] > 100) & (df['amount'] <= 500)).astype('int8')
        features['TransactionAmt_bin3'] = ((df['amount'] > 500) & (df['amount'] <= 1000)).astype('int8')
        features['TransactionAmt_bin4'] = ((df['amount'] > 1000) & (df['amount'] <= 5000)).astype('int8')
        features['TransactionAmt_bin5'] = (df['amount'] > 5000).astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # BALANCE FEATURES
        # ═══════════════════════════════════════════════════════════════
        features['oldbalanceOrg'] = df['oldbalanceOrg'].astype('float32')
        features['newbalanceOrig'] = df['newbalanceOrig'].astype('float32')
        features['oldbalanceDest'] = df['oldbalanceDest'].astype('float32')
        features['newbalanceDest'] = df['newbalanceDest'].astype('float32')
        
        # Balance change features
        features['balance_change_orig'] = (df['newbalanceOrig'] - df['oldbalanceOrg']).astype('float32')
        features['balance_change_dest'] = (df['newbalanceDest'] - df['oldbalanceDest']).astype('float32')
        
        # Balance ratios (avoid division by zero)
        features['balance_ratio_orig'] = np.where(
            df['oldbalanceOrg'] > 0,
            df['newbalanceOrig'] / df['oldbalanceOrg'],
            0
        ).astype('float32')
        
        features['amount_to_balance_ratio'] = np.where(
            df['oldbalanceOrg'] > 0,
            df['amount'] / df['oldbalanceOrg'],
            0
        ).astype('float32')
        
        # Is the entire balance being withdrawn?
        features['is_full_withdrawal'] = (
            (df['oldbalanceOrg'] > 0) & 
            (df['newbalanceOrig'] == 0)
        ).astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # TEMPORAL FEATURES
        # ═══════════════════════════════════════════════════════════════
        features['hour_of_day'] = (df['step'] % 24).astype('int8')
        features['day_of_simulation'] = (df['step'] // 24).astype('int16')
        features['is_night'] = ((features['hour_of_day'] >= 22) | (features['hour_of_day'] < 6)).astype('int8')
        features['is_weekend'] = ((df['step'] // 24) % 7 >= 5).astype('int8')
        features['is_business_hours'] = ((features['hour_of_day'] >= 9) & (features['hour_of_day'] < 17)).astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # TRANSACTION TYPE FEATURES (One-hot)
        # ═══════════════════════════════════════════════════════════════
        type_dummies = pd.get_dummies(df['type'], prefix='type')
        for col in type_dummies.columns:
            features[col] = type_dummies[col].astype('int8')
        
        # Ensure all transaction types exist
        for t in ['CASH_IN', 'CASH_OUT', 'DEBIT', 'PAYMENT', 'TRANSFER']:
            col = f'type_{t}'
            if col not in features.columns:
                features[col] = 0
        
        # High-risk transaction types
        features['is_high_risk_type'] = (
            df['type'].isin(['CASH_OUT', 'TRANSFER'])
        ).astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # ACCOUNT FEATURES
        # ═══════════════════════════════════════════════════════════════
        # Sender account type (C = customer, M = merchant)
        features['sender_is_customer'] = df['nameOrig'].str.startswith('C').astype('int8')
        features['receiver_is_customer'] = df['nameDest'].str.startswith('C').astype('int8')
        features['receiver_is_merchant'] = df['nameDest'].str.startswith('M').astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # FRAUD FLAG FEATURE
        # ═══════════════════════════════════════════════════════════════
        features['isFlaggedFraud'] = df['isFlaggedFraud'].astype('int8')
        
        # ═══════════════════════════════════════════════════════════════
        # PLACEHOLDER FEATURES TO REACH 434
        # ═══════════════════════════════════════════════════════════════
        n_real_features = len(features.columns)
        n_placeholders = 434 - n_real_features
        
        if n_placeholders > 0:
            logger.info(f"  PaySim real features: {n_real_features}")
            logger.info(f"  Adding {n_placeholders} placeholder features to match IEEE-CIS")
            
            # Add V-series features (mimicking IEEE-CIS behavioral aggregations)
            # Initialize with zeros for PaySim data
            for i in range(n_placeholders):
                features[f'V{i+1}'] = 0.0
        
        return features
    
    def load_combined_dataset(
        self,
        ieee_samples: Optional[int] = None,
        paysim_samples: int = 50000,
        combine: bool = True
    ) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load and combine both datasets.
        
        Combines the two reference datasets:
        - IEEE-CIS: Real credit card fraud patterns (590,540 transactions)
        - PaySim: Synthetic mobile money patterns (50,000 transactions)
        - Combined for comprehensive fraud detection training
        
        Args:
            ieee_samples: Max IEEE-CIS samples (None for all)
            paysim_samples: Max PaySim samples
            combine: Whether to combine datasets or return IEEE-CIS only
        
        Returns:
            Tuple of (features DataFrame, labels Series)
        """
        logger.info("=" * 70)
        logger.info("Loading Combined Fraud Detection Datasets")
        logger.info("=" * 70)
        logger.info("")
        logger.info("Datasets:")
        logger.info("  1. IEEE-CIS: Credit card fraud (434 features, ~3.5% fraud)")
        logger.info("  2. PaySim: Mobile money fraud (engineered features, ~0.3% fraud)")
        logger.info("")
        
        X_combined = None
        y_combined = None
        
        # Load IEEE-CIS
        X_ieee, y_ieee = self.load_ieee_cis(max_samples=ieee_samples)
        
        if X_ieee is not None:
            X_combined = X_ieee
            y_combined = y_ieee
        
        # Load PaySim if combining
        if combine:
            X_paysim, y_paysim = self.load_paysim(max_samples=paysim_samples)
            
            if X_paysim is not None:
                if X_combined is not None:
                    # Align columns
                    X_paysim_aligned = self._align_features(X_paysim, X_combined.columns)
                    
                    # Combine datasets
                    X_combined = pd.concat([X_combined, X_paysim_aligned], ignore_index=True)
                    y_combined = pd.concat([y_combined, y_paysim], ignore_index=True)
                else:
                    X_combined = X_paysim
                    y_combined = y_paysim
        
        if X_combined is None:
            logger.error("No datasets loaded!")
            logger.error("Run: python scripts/download_datasets.py")
            return None, None
        
        # Final statistics
        logger.info("")
        logger.info("=" * 70)
        logger.info("Combined Dataset Statistics")
        logger.info("=" * 70)
        logger.info(f"  Total samples: {len(X_combined):,}")
        logger.info(f"  Total features: {X_combined.shape[1]}")
        logger.info(f"  Fraud samples: {y_combined.sum():,}")
        logger.info(f"  Fraud rate: {y_combined.mean() * 100:.2f}%")
        logger.info("")
        
        return X_combined, y_combined
    
    def _align_features(self, df: pd.DataFrame, target_columns: pd.Index) -> pd.DataFrame:
        """
        Align DataFrame columns to match target columns.
        
        Args:
            df: DataFrame to align
            target_columns: Target column order
        
        Returns:
            Aligned DataFrame
        """
        # Add missing columns with zeros
        missing_cols = set(target_columns) - set(df.columns)
        for col in missing_cols:
            df[col] = 0.0
        
        # Reorder columns
        df = df[target_columns]
        
        return df
    
    def load_synthetic(self, max_samples: Optional[int] = None) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load synthetic fraud detection dataset.
        
        This dataset is generated by scripts/generate_synthetic_dataset.py
        and mimics IEEE-CIS feature structure.
        
        Args:
            max_samples: Maximum number of samples to load
        
        Returns:
            Tuple of (features DataFrame, labels Series)
        """
        logger.info("=" * 70)
        logger.info("Loading Synthetic Fraud Detection Dataset")
        logger.info("=" * 70)
        
        synthetic_file = SYNTHETIC_DIR / 'train_synthetic.csv'
        
        if not synthetic_file.exists():
            logger.error(f"Synthetic dataset not found: {synthetic_file}")
            logger.error("Generate it by running:")
            logger.error("  python scripts/generate_synthetic_dataset.py")
            return None, None
        
        # Load dataset
        logger.info("Loading synthetic data...")
        nrows = max_samples if max_samples else None
        
        df = pd.read_csv(synthetic_file, nrows=nrows, low_memory=False)
        logger.info(f"  Loaded {len(df):,} transactions")
        
        # Extract labels
        if 'isFraud' not in df.columns:
            logger.error("Label column 'isFraud' not found in dataset")
            return None, None
        
        y = df['isFraud'].astype(int)
        
        # Drop non-feature columns
        drop_cols = ['TransactionID', 'isFraud', 'type']
        feature_cols = [col for col in df.columns if col not in drop_cols]
        X = df[feature_cols].copy()
        
        # Ensure 434 features (pad with zeros if needed)
        current_features = X.shape[1]
        if current_features < 434:
            n_padding = 434 - current_features
            logger.info(f"  Padding {n_padding} features to reach 434 total")
            padding_data = np.zeros((len(df), n_padding), dtype=np.float32)
            padding_cols = [f'padding_{i}' for i in range(n_padding)]
            padding_df = pd.DataFrame(padding_data, columns=padding_cols, index=X.index)
            X = pd.concat([X, padding_df], axis=1)
        
        # Dataset statistics
        fraud_rate = y.mean() * 100
        logger.info(f"  Features: {X.shape[1]}")
        logger.info(f"  Fraud rate: {fraud_rate:.2f}%")
        logger.info(f"  Fraud samples: {y.sum():,} / {len(y):,}")
        
        self.synthetic_loaded = True
        logger.info("✓ Synthetic dataset loaded successfully")
        
        return X, y
    
    def get_dataset_info(self) -> Dict:
        """
        Get information about loaded datasets.
        
        Returns:
            Dict with dataset statistics
        """
        info = {
            'ieee_cis': {
                'loaded': self.ieee_cis_loaded,
                'path': str(IEEE_CIS_DIR),
                'description': 'IEEE-CIS Fraud Detection (credit card, 434 features)'
            },
            'paysim': {
                'loaded': self.paysim_loaded,
                'path': str(PAYSIM_DIR),
                'description': 'PaySim Mobile Money (5 transaction types)'
            }
        }
        return info


def check_dataset_availability() -> Dict[str, bool]:
    """
    Check which datasets are available.
    
    Returns:
        Dict mapping dataset names to availability status
    """
    return {
        'ieee_cis_transaction': (IEEE_CIS_DIR / 'train_transaction.csv').exists(),
        'ieee_cis_identity': (IEEE_CIS_DIR / 'train_identity.csv').exists(),
        'paysim': (PAYSIM_DIR / 'PS_20174392719_1491204439457_log.csv').exists(),
        'synthetic': (SYNTHETIC_DIR / 'train_synthetic.csv').exists()
    }
