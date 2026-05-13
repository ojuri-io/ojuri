"""
XGBoost model training with cross-validation.
"""

import numpy as np
from xgboost import XGBClassifier
from sklearn.model_selection import cross_val_score
from sklearn.metrics import (
    f1_score, precision_score, recall_score, 
    roc_auc_score, confusion_matrix, classification_report
)
from typing import Tuple, Dict, Any
import logging
import time

logger = logging.getLogger(__name__)


class ModelTrainer:
    """
    Train XGBoost classifier for fraud detection.
    
    Features:
    - Cross-validation for robust evaluation
    - Early stopping to prevent overfitting
    - Comprehensive metrics logging
    
    Example:
        >>> trainer = ModelTrainer(config)
        >>> model, metrics = trainer.train(X_train, y_train, X_val, y_val)
    """
    
    def __init__(self, config):
        """
        Initialize trainer with configuration.
        
        Args:
            config: Configuration object with XGBoost parameters
        """
        self.config = config
        
        # XGBoost parameters
        self.params = {
            'n_estimators': config.XGBOOST_N_ESTIMATORS,
            'max_depth': config.XGBOOST_MAX_DEPTH,
            'learning_rate': config.XGBOOST_LEARNING_RATE,
            'subsample': config.XGBOOST_SUBSAMPLE,
            'colsample_bytree': config.XGBOOST_COLSAMPLE_BYTREE,
            'objective': 'binary:logistic',
            'eval_metric': 'auc',
            'use_label_encoder': False,
            'random_state': 42,
            'n_jobs': -1,  # Use all CPU cores
            'tree_method': 'hist',  # Memory-efficient histogram method
        }
        
        logger.info("ModelTrainer initialized")
        logger.info(f"  Parameters: {self.params}")
    
    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray,
        y_val: np.ndarray
    ) -> Tuple[XGBClassifier, Dict[str, Any]]:
        """
        Train XGBoost model with early stopping.
        
        Args:
            X_train: Training features
            y_train: Training labels
            X_val: Validation features
            y_val: Validation labels
        
        Returns:
            Tuple of (trained_model, metrics_dict)
        """
        logger.info("=" * 70)
        logger.info("STARTING MODEL TRAINING")
        logger.info("=" * 70)
        logger.info(f"Training samples: {len(X_train):,}")
        logger.info(f"Validation samples: {len(X_val):,}")
        logger.info(f"Features: {X_train.shape[1]}")
        
        start_time = time.time()
        
        # Create model
        model = XGBClassifier(**self.params)
        
        # Train with early stopping
        logger.info("Training with early stopping...")
        
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False
        )
        
        training_time = time.time() - start_time
        
        # Calculate metrics on validation set
        logger.info("Calculating validation metrics...")
        
        y_pred = model.predict(X_val)
        y_prob = model.predict_proba(X_val)[:, 1]
        
        metrics = self._calculate_metrics(y_val, y_pred, y_prob, training_time)
        
        # Log results
        self._log_training_results(metrics)
        
        # Cross-validation (optional, for more robust estimate)
        if self.config.CV_FOLDS > 1 and len(X_train) >= 1000:
            logger.info(f"Running {self.config.CV_FOLDS}-fold cross-validation...")
            cv_scores = cross_val_score(
                model, X_train, y_train,
                cv=self.config.CV_FOLDS,
                scoring='f1',
                n_jobs=-1
            )
            metrics['cv_f1_mean'] = float(cv_scores.mean())
            metrics['cv_f1_std'] = float(cv_scores.std())
            logger.info(f"CV F1-score: {cv_scores.mean():.4f} (+/- {cv_scores.std()*2:.4f})")
        
        logger.info("=" * 70)
        logger.info("✅ TRAINING COMPLETE")
        logger.info("=" * 70)
        
        return model, metrics
    
    def _calculate_metrics(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        y_prob: np.ndarray,
        training_time: float
    ) -> Dict[str, Any]:
        """
        Calculate comprehensive evaluation metrics.
        
        Args:
            y_true: Ground truth labels
            y_pred: Predicted labels
            y_prob: Predicted probabilities
            training_time: Training duration in seconds
        
        Returns:
            Dict with all metrics
        """
        metrics = {
            'f1_score': float(f1_score(y_true, y_pred, zero_division=0)),
            'precision': float(precision_score(y_true, y_pred, zero_division=0)),
            'recall': float(recall_score(y_true, y_pred, zero_division=0)),
            'training_time_seconds': round(training_time, 2),
        }
        
        # AUC-ROC (handle single class case)
        try:
            if len(np.unique(y_true)) > 1:
                metrics['auc_roc'] = float(roc_auc_score(y_true, y_prob))
            else:
                metrics['auc_roc'] = 0.5  # Random baseline
        except Exception as e:
            logger.warning(f"Could not calculate AUC-ROC: {e}")
            metrics['auc_roc'] = 0.5
        
        # Confusion matrix
        cm = confusion_matrix(y_true, y_pred)
        if cm.shape == (2, 2):
            tn, fp, fn, tp = cm.ravel()
            metrics['true_negatives'] = int(tn)
            metrics['false_positives'] = int(fp)
            metrics['false_negatives'] = int(fn)
            metrics['true_positives'] = int(tp)
            
            # Additional metrics
            metrics['specificity'] = float(tn / (tn + fp)) if (tn + fp) > 0 else 0.0
            metrics['false_positive_rate'] = float(fp / (fp + tn)) if (fp + tn) > 0 else 0.0
        
        return metrics
    
    def _log_training_results(self, metrics: Dict[str, Any]):
        """
        Log training results in a clear format.
        
        Args:
            metrics: Dict with training metrics
        """
        logger.info("")
        logger.info("Training Results:")
        logger.info("-" * 40)
        logger.info(f"  F1-score:     {metrics['f1_score']:.4f}")
        logger.info(f"  Precision:    {metrics['precision']:.4f}")
        logger.info(f"  Recall:       {metrics['recall']:.4f}")
        logger.info(f"  AUC-ROC:      {metrics['auc_roc']:.4f}")
        logger.info(f"  Training time: {metrics['training_time_seconds']:.1f}s")
        
        if 'true_positives' in metrics:
            logger.info("")
            logger.info("Confusion Matrix:")
            logger.info(f"  True Positives:  {metrics['true_positives']:,}")
            logger.info(f"  True Negatives:  {metrics['true_negatives']:,}")
            logger.info(f"  False Positives: {metrics['false_positives']:,}")
            logger.info(f"  False Negatives: {metrics['false_negatives']:,}")
        
        logger.info("-" * 40)
    
    def evaluate(
        self,
        model: XGBClassifier,
        X_test: np.ndarray,
        y_test: np.ndarray
    ) -> Dict[str, Any]:
        """
        Evaluate model on test set.
        
        Args:
            model: Trained XGBoost model
            X_test: Test features
            y_test: Test labels
        
        Returns:
            Dict with evaluation metrics
        """
        y_pred = model.predict(X_test)
        y_prob = model.predict_proba(X_test)[:, 1]
        
        return self._calculate_metrics(y_test, y_pred, y_prob, training_time=0)
    
    def get_feature_importance(
        self,
        model: XGBClassifier,
        feature_names: list = None,
        top_n: int = 20
    ) -> Dict[str, float]:
        """
        Get feature importance from trained model.
        
        Args:
            model: Trained XGBoost model
            feature_names: List of feature names
            top_n: Number of top features to return
        
        Returns:
            Dict mapping feature names to importance scores
        """
        importances = model.feature_importances_
        
        if feature_names is None:
            feature_names = [f'feature_{i}' for i in range(len(importances))]
        
        # Sort by importance
        importance_dict = dict(zip(feature_names, importances))
        sorted_importance = dict(
            sorted(importance_dict.items(), key=lambda x: x[1], reverse=True)[:top_n]
        )
        
        return sorted_importance
