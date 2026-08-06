"""
XGBoost model training with cross-validation.
"""

import numpy as np
from xgboost import XGBClassifier
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.metrics import (
    f1_score, precision_score, recall_score,
    roc_auc_score, confusion_matrix, classification_report
)
from imblearn.over_sampling import SMOTE
from imblearn.pipeline import Pipeline as ImbPipeline
from typing import Tuple, Dict, Any, Optional
import logging
import time

from src.training.calibration import Calibrator, brier_score
from src.training.splits import PreprocessedSplits

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
        self.early_stopping_rounds = getattr(config, "XGBOOST_EARLY_STOPPING_ROUNDS", 0)

        logger.info("ModelTrainer initialized")
        logger.info(f"  Parameters: {self.params}")
    
    def train(
        self,
        splits: PreprocessedSplits,
        mode: str = "FRESH",
        prior_model: Optional[XGBClassifier] = None,
        continued_trees: int = 50,
    ) -> Tuple[XGBClassifier, Optional[Calibrator], Dict[str, Any]]:
        logger.info("=" * 70)
        logger.info("STARTING MODEL TRAINING")
        logger.info("=" * 70)
        X_train, y_train = splits.X_train, splits.y_train
        X_val, y_val = splits.X_val, splits.y_val
        X_cal, y_cal = splits.X_cal, splits.y_cal
        logger.info(f"Training samples: {len(X_train):,} (augmented)")
        logger.info(f"Calibration samples: {len(X_cal):,} (raw, held out pre-augmentation)")
        logger.info(f"Validation samples: {len(X_val):,}")
        logger.info(f"Features: {X_train.shape[1]}")

        start_time = time.time()

        effective_mode = mode if mode in ("FRESH", "CONTINUED") else "FRESH"
        use_continued = effective_mode == "CONTINUED" and prior_model is not None

        if use_continued:
            params = {**self.params, "n_estimators": continued_trees}
            model = XGBClassifier(**params)
            logger.info(f"Mode=CONTINUED — seeding from prior model, adding {continued_trees} trees")
            model.fit(
                X_train, y_train,
                eval_set=[(X_val, y_val)],
                xgb_model=prior_model.get_booster(),
                verbose=False,
            )
        else:
            if effective_mode == "CONTINUED" and prior_model is None:
                logger.warning("Mode=CONTINUED requested but no prior model available — falling back to FRESH")
            model = XGBClassifier(**self._fresh_params())
            logger.info(
                "Mode=FRESH — training from scratch (early_stopping_rounds=%s)",
                self.early_stopping_rounds,
            )
            model.fit(
                X_train, y_train,
                eval_set=[(X_val, y_val)],
                verbose=False,
            )

        training_time = time.time() - start_time

        calibrator, calibration_metrics = self._calibrate(model, X_cal, y_cal, X_val, y_val)

        logger.info("Calculating validation metrics...")
        y_pred = model.predict(X_val)
        y_prob_raw = model.predict_proba(X_val)[:, 1]
        y_prob = calibrator.transform(y_prob_raw) if calibrator else y_prob_raw

        metrics = self._calculate_metrics(y_val, y_pred, y_prob, training_time)
        metrics.update(calibration_metrics)
        metrics["training_mode"] = "CONTINUED" if use_continued else "FRESH"
        if use_continued:
            metrics["continued_trees"] = continued_trees
        
        # Log results
        self._log_training_results(metrics)
        
        cv = self._cross_validate(splits)
        metrics.update(cv)
        
        logger.info("=" * 70)
        logger.info("✅ TRAINING COMPLETE")
        logger.info("=" * 70)

        return model, calibrator, metrics

    def _fresh_params(self) -> Dict[str, Any]:
        """The class advertised early stopping and passed an eval_set, but
        never configured `early_stopping_rounds` — so every run trained
        all n_estimators trees and the eval_set was collected and
        discarded."""
        if self.early_stopping_rounds <= 0:
            return self.params
        return {**self.params, "early_stopping_rounds": self.early_stopping_rounds}

    def _cross_validate(self, splits: PreprocessedSplits) -> Dict[str, Any]:
        """
        CV on pre-augmentation rows with resampling inside each fold.
        Scoring the post-SMOTE matrix let synthetic points interpolated
        from a training row land in the validation fold, inflating the
        `cv_f1_mean` persisted to meta.json and shown in the UI.
        """
        X, y = splits.X_fit_raw, splits.y_fit_raw
        if self.config.CV_FOLDS <= 1 or len(X) < 1000:
            return {}
        if len(np.unique(y)) < 2:
            logger.warning("Skipping cross-validation — single-class training data")
            return {}

        minority = int(min(np.bincount(y.astype(int))))
        folds = int(min(self.config.CV_FOLDS, minority))
        if folds < 2:
            logger.warning("Skipping cross-validation — too few minority samples (%d)", minority)
            return {}

        logger.info(f"Running {folds}-fold cross-validation (SMOTE inside each fold)...")
        pipeline = ImbPipeline([
            ("smote", SMOTE(sampling_strategy=self.config.SMOTE_RATIO, random_state=42)),
            ("model", XGBClassifier(**self.params)),
        ])
        try:
            cv_scores = cross_val_score(
                pipeline, X, y,
                cv=StratifiedKFold(n_splits=folds, shuffle=False),
                scoring="f1",
                n_jobs=-1,
            )
        except Exception as e:
            logger.warning("Cross-validation failed: %s", e)
            return {}

        logger.info(f"CV F1-score: {cv_scores.mean():.4f} (+/- {cv_scores.std()*2:.4f})")
        return {
            "cv_f1_mean": float(cv_scores.mean()),
            "cv_f1_std": float(cv_scores.std()),
            "cv_folds": folds,
        }

    def _calibrate(
        self,
        model: XGBClassifier,
        X_cal: np.ndarray,
        y_cal: np.ndarray,
        X_val: np.ndarray,
        y_val: np.ndarray,
    ) -> Tuple[Optional[Calibrator], Dict[str, Any]]:
        if len(X_cal) == 0:
            logger.info("Skipping calibration — calibration split is empty")
            return None, {}

        scores_cal = model.predict_proba(X_cal)[:, 1]
        calibrator = Calibrator().fit(scores_cal, y_cal)

        scores_val_raw = model.predict_proba(X_val)[:, 1]
        scores_val_calibrated = calibrator.transform(scores_val_raw)
        brier_before = brier_score(y_val, scores_val_raw)
        brier_after = brier_score(y_val, scores_val_calibrated)

        logger.info(
            "Calibration: Brier %.4f → %.4f (delta %.4f)",
            brier_before, brier_after, brier_before - brier_after,
        )

        return calibrator, {
            "brier_score": float(brier_after),
            "brier_score_uncalibrated": float(brier_before),
        }
    
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

        # Coerce numpy.float32 → built-in float so callers (and JSON
        # serialisers downstream) get a clean Python type, not a numpy
        # scalar that fails `isinstance(v, float)` checks.
        importance_dict = {name: float(v) for name, v in zip(feature_names, importances)}
        sorted_importance = dict(
            sorted(importance_dict.items(), key=lambda x: x[1], reverse=True)[:top_n]
        )

        return sorted_importance
