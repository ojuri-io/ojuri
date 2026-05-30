"""
Data preprocessing with SMOTE and feature normalization.
"""

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from imblearn.over_sampling import SMOTE
from typing import Tuple, Optional
import logging

from src.config import config

logger = logging.getLogger(__name__)


class DataPreprocessor:
    """
    Preprocess data for XGBoost training.
    
    Pipeline:
    1. Train/validation/test split (60/20/20)
    2. SMOTE oversampling for class balance
    3. StandardScaler normalization
    
    Example:
        >>> preprocessor = DataPreprocessor()
        >>> X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
    """
    
    def __init__(self):
        # Identity scaler: RDA does not apply the paired scaler.npz at
        # inference, and XGBoost (tree-based) doesn't need scaling.
        self.scaler = StandardScaler(with_mean=False, with_std=False)
        self.smote_ratio = config.SMOTE_RATIO
        self._is_fitted = False
        
        logger.info(f"DataPreprocessor initialized (SMOTE ratio: {self.smote_ratio})")
    
    def preprocess(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        test_size: float = 0.2,
        val_size: float = 0.25  # 0.25 of remaining = 0.2 of total
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """
        Full preprocessing pipeline.
        
        Args:
            X: Feature DataFrame
            y: Labels Series
            test_size: Fraction for test set
            val_size: Fraction of train set for validation
        
        Returns:
            Tuple of (X_train, X_val, X_test, y_train, y_val, y_test)
        """
        logger.info("Starting preprocessing pipeline...")
        logger.info(f"  Input shape: {X.shape}")
        logger.info(f"  Class distribution: {dict(y.value_counts())}")
        
        # Convert to numpy
        X_array = X.values.astype(np.float32)
        y_array = y.values.astype(np.int32)
        
        # Handle NaN and inf values
        X_array = np.nan_to_num(X_array, nan=0.0, posinf=0.0, neginf=0.0)
        
        # Step 1: Train/test split
        logger.info("Step 1: Train/test split...")
        X_temp, X_test, y_temp, y_test = train_test_split(
            X_array, y_array,
            test_size=test_size,
            stratify=y_array,
            random_state=42
        )
        
        # Step 2: Train/validation split
        logger.info("Step 2: Train/validation split...")
        X_train, X_val, y_train, y_val = train_test_split(
            X_temp, y_temp,
            test_size=val_size,
            stratify=y_temp,
            random_state=42
        )
        
        logger.info(f"  Train: {len(X_train)} samples")
        logger.info(f"  Val: {len(X_val)} samples")
        logger.info(f"  Test: {len(X_test)} samples")
        
        # Step 3: SMOTE oversampling (only on training data)
        logger.info("Step 3: SMOTE oversampling...")
        X_train, y_train = self._apply_smote(X_train, y_train)
        
        # Step 4: Feature scaling
        logger.info("Step 4: Feature scaling...")
        X_train = self._fit_transform(X_train)
        X_val = self._transform(X_val)
        X_test = self._transform(X_test)
        
        logger.info("✅ Preprocessing complete")
        logger.info(f"  Final train shape: {X_train.shape}")
        logger.info(f"  Final train class distribution: {dict(zip(*np.unique(y_train, return_counts=True)))}")
        
        return X_train, X_val, X_test, y_train, y_val, y_test
    
    def _apply_smote(
        self,
        X: np.ndarray,
        y: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Apply SMOTE oversampling to balance classes.
        
        Args:
            X: Features array
            y: Labels array
        
        Returns:
            Tuple of (X_resampled, y_resampled)
        """
        # Check class distribution
        class_counts = dict(zip(*np.unique(y, return_counts=True)))
        minority_count = min(class_counts.values())
        majority_count = max(class_counts.values())
        
        logger.info(f"  Before SMOTE: {class_counts}")
        
        # Skip SMOTE if already balanced or not enough minority samples
        if minority_count >= majority_count * 0.8:
            logger.info("  Classes already balanced, skipping SMOTE")
            return X, y
        
        if minority_count < 6:  # SMOTE needs at least k_neighbors + 1 samples
            logger.warning(f"  Not enough minority samples ({minority_count}) for SMOTE")
            return X, y
        
        try:
            # Determine k_neighbors based on minority class size
            k_neighbors = min(5, minority_count - 1)
            
            smote = SMOTE(
                sampling_strategy=self.smote_ratio,
                k_neighbors=k_neighbors,
                random_state=42,
                n_jobs=-1
            )
            
            X_resampled, y_resampled = smote.fit_resample(X, y)
            
            class_counts_after = dict(zip(*np.unique(y_resampled, return_counts=True)))
            logger.info(f"  After SMOTE: {class_counts_after}")
            
            return X_resampled, y_resampled
            
        except Exception as e:
            logger.warning(f"  SMOTE failed: {e}")
            logger.warning("  Continuing without oversampling")
            return X, y
    
    def _fit_transform(self, X: np.ndarray) -> np.ndarray:
        """
        Fit scaler and transform features.
        
        Args:
            X: Features array
        
        Returns:
            Scaled features array
        """
        X_scaled = self.scaler.fit_transform(X)
        self._is_fitted = True
        return X_scaled.astype(np.float32)
    
    def _transform(self, X: np.ndarray) -> np.ndarray:
        """
        Transform features using fitted scaler.
        
        Args:
            X: Features array
        
        Returns:
            Scaled features array
        """
        if not self._is_fitted:
            raise RuntimeError("Scaler not fitted. Call preprocess() first.")
        
        X_scaled = self.scaler.transform(X)
        return X_scaled.astype(np.float32)
    
    def get_scaler(self) -> StandardScaler:
        """
        Get the fitted scaler for use in ONNX conversion.
        
        Returns:
            Fitted StandardScaler instance
        """
        if not self._is_fitted:
            raise RuntimeError("Scaler not fitted. Call preprocess() first.")
        return self.scaler
    
    def get_scaler_params(self) -> dict:
        """
        Get scaler parameters for saving.
        
        Returns:
            Dict with mean and scale arrays
        """
        if not self._is_fitted:
            raise RuntimeError("Scaler not fitted. Call preprocess() first.")
        
        return {
            'mean': self.scaler.mean_,
            'scale': self.scaler.scale_,
            'var': self.scaler.var_
        }
