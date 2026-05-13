"""
Drift detection using Population Stability Index (PSI) and F1-score monitoring.

Concept drift occurs when the statistical properties of model inputs/outputs
change over time, causing model performance to degrade.

This module monitors two types of drift:
1. Data Drift (PSI): Changes in feature distributions
2. Concept Drift (F1): Changes in prediction accuracy
"""

import numpy as np
from collections import deque
from typing import Dict, List, Tuple, Optional
from sklearn.metrics import f1_score, precision_score, recall_score
import logging

logger = logging.getLogger(__name__)


class DriftDetector:
    """
    Monitor for concept and data drift in production model.
    
    Uses a sliding window approach to track:
    - F1-score trend (concept drift)
    - PSI scores for key features (data drift)
    
    Triggers retraining when:
    - F1-score drops below threshold OR
    - Max PSI exceeds threshold
    
    Example:
        >>> detector = DriftDetector(window_size=1000, f1_threshold=0.92)
        >>> detector.update(prediction=1, actual=1, probability=0.85, features={})
        >>> drift_detected, metrics = detector.check_drift()
    """
    
    def __init__(
        self,
        window_size: int = 1000,
        f1_threshold: float = 0.92,
        psi_threshold: float = 0.25
    ):
        """
        Initialize drift detector.
        
        Args:
            window_size: Number of samples in sliding window
            f1_threshold: F1-score below which drift is flagged
            psi_threshold: PSI above which drift is flagged
        """
        self.window_size = window_size
        self.f1_threshold = f1_threshold
        self.psi_threshold = psi_threshold
        
        # Sliding windows for predictions and actuals
        self.predictions = deque(maxlen=window_size)
        self.actuals = deque(maxlen=window_size)
        self.probabilities = deque(maxlen=window_size)
        
        # Feature distributions for PSI
        self.feature_windows: Dict[str, deque] = {}
        self.baseline_distributions: Dict[str, np.ndarray] = {}
        
        # Number of bins for PSI calculation
        self.psi_bins = 10
        
        logger.info(f"DriftDetector initialized:")
        logger.info(f"  Window size: {window_size}")
        logger.info(f"  F1 threshold: {f1_threshold}")
        logger.info(f"  PSI threshold: {psi_threshold}")
    
    def update(
        self,
        prediction: int,
        actual: int,
        probability: float,
        features: Dict[str, float]
    ):
        """
        Update drift detector with new sample.
        
        Args:
            prediction: Model's binary prediction (0 or 1)
            actual: Ground truth label (0 or 1)
            probability: Model's fraud probability
            features: Dictionary of feature values
        """
        self.predictions.append(prediction)
        self.actuals.append(actual)
        self.probabilities.append(probability)
        
        # Update feature windows
        for feature_name, value in features.items():
            if feature_name not in self.feature_windows:
                self.feature_windows[feature_name] = deque(maxlen=self.window_size)
            self.feature_windows[feature_name].append(value)
    
    def check_drift(self) -> Tuple[bool, Dict]:
        """
        Check for drift in current window.
        
        Returns:
            Tuple of (drift_detected, metrics_dict)
        """
        metrics = {
            'f1_score': 0.0,
            'precision': 0.0,
            'recall': 0.0,
            'max_psi': 0.0,
            'psi_features': {},
            'drift_reasons': [],
            'sample_count': len(self.actuals)
        }
        
        # Need minimum samples for reliable metrics
        min_samples = max(100, self.window_size // 10)
        if len(self.actuals) < min_samples:
            logger.debug(f"Not enough samples for drift check: {len(self.actuals)} < {min_samples}")
            return False, metrics
        
        # Calculate F1-score
        actuals = list(self.actuals)
        predictions = list(self.predictions)
        
        # Handle edge case: all same class
        if len(set(actuals)) == 1 or len(set(predictions)) == 1:
            logger.warning("All samples have same class - cannot calculate F1")
            metrics['f1_score'] = 1.0  # Assume no drift
        else:
            metrics['f1_score'] = f1_score(actuals, predictions, zero_division=1.0)
            metrics['precision'] = precision_score(actuals, predictions, zero_division=1.0)
            metrics['recall'] = recall_score(actuals, predictions, zero_division=1.0)
        
        # Calculate PSI for each feature
        drift_detected = False
        
        for feature_name, window in self.feature_windows.items():
            if feature_name in self.baseline_distributions and len(window) >= min_samples:
                psi = self._calculate_psi(
                    baseline=self.baseline_distributions[feature_name],
                    current=np.array(list(window))
                )
                metrics['psi_features'][feature_name] = psi
                
                if psi > metrics['max_psi']:
                    metrics['max_psi'] = psi
        
        # Check drift conditions
        if metrics['f1_score'] < self.f1_threshold:
            drift_detected = True
            metrics['drift_reasons'].append(
                f"F1-score {metrics['f1_score']:.4f} < threshold {self.f1_threshold}"
            )
        
        if metrics['max_psi'] > self.psi_threshold:
            drift_detected = True
            # Find features with high PSI
            high_psi_features = [
                f for f, psi in metrics['psi_features'].items() 
                if psi > self.psi_threshold
            ]
            metrics['drift_reasons'].append(
                f"PSI {metrics['max_psi']:.4f} > threshold {self.psi_threshold} "
                f"(features: {high_psi_features})"
            )
        
        return drift_detected, metrics
    
    def _calculate_psi(
        self, 
        baseline: np.ndarray, 
        current: np.ndarray
    ) -> float:
        """
        Calculate Population Stability Index (PSI).
        
        PSI measures how much a distribution has shifted from a baseline.
        
        Interpretation:
        - PSI < 0.10: No significant drift
        - 0.10 <= PSI < 0.25: Moderate drift, monitor closely
        - PSI >= 0.25: Significant drift, investigate
        
        Args:
            baseline: Baseline distribution values
            current: Current distribution values
        
        Returns:
            PSI score (0.0+, higher = more drift)
        """
        # Handle empty arrays
        if len(baseline) == 0 or len(current) == 0:
            return 0.0
        
        # Create bins based on baseline
        try:
            _, bin_edges = np.histogram(baseline, bins=self.psi_bins)
        except ValueError:
            return 0.0
        
        # Calculate proportions in each bin
        baseline_counts, _ = np.histogram(baseline, bins=bin_edges)
        current_counts, _ = np.histogram(current, bins=bin_edges)
        
        # Normalize to proportions
        baseline_props = baseline_counts / len(baseline)
        current_props = current_counts / len(current)
        
        # Add small constant to avoid division by zero
        epsilon = 1e-10
        baseline_props = np.clip(baseline_props, epsilon, 1.0)
        current_props = np.clip(current_props, epsilon, 1.0)
        
        # Calculate PSI
        psi = np.sum(
            (current_props - baseline_props) * 
            np.log(current_props / baseline_props)
        )
        
        return float(psi)
    
    def set_baseline_distributions(self, distributions: Dict[str, List[float]]):
        """
        Set baseline distributions for PSI calculation.
        
        Call this after initial training to establish baseline.
        
        Args:
            distributions: Dict mapping feature names to value arrays
        """
        self.baseline_distributions = {}
        
        for feature_name, values in distributions.items():
            if len(values) > 0:
                self.baseline_distributions[feature_name] = np.array(values)
        
        logger.info(f"Set baseline distributions for {len(self.baseline_distributions)} features")
    
    def reset(self):
        """
        Reset drift detector state.
        
        Call this after retraining to start fresh monitoring.
        """
        self.predictions.clear()
        self.actuals.clear()
        self.probabilities.clear()
        
        for window in self.feature_windows.values():
            window.clear()
        
        logger.info("DriftDetector reset")
    
    def get_stats(self) -> Dict:
        """
        Get current statistics.
        
        Returns:
            Dict with current window stats
        """
        stats = {
            'sample_count': len(self.actuals),
            'window_size': self.window_size,
            'baseline_features': len(self.baseline_distributions),
            'tracked_features': len(self.feature_windows)
        }
        
        if len(self.actuals) > 0:
            stats['fraud_rate'] = sum(self.actuals) / len(self.actuals)
            stats['avg_probability'] = sum(self.probabilities) / len(self.probabilities)
        
        return stats
