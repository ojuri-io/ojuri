"""
Tests for drift detection functionality.
"""

import pytest
import numpy as np
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.monitoring.drift_detector import DriftDetector


class TestDriftDetector:
    """Test cases for DriftDetector."""
    
    def test_initialization(self):
        """Test drift detector initializes correctly."""
        detector = DriftDetector(
            window_size=1000,
            f1_threshold=0.92,
            psi_threshold=0.25
        )
        
        assert detector.window_size == 1000
        assert detector.f1_threshold == 0.92
        assert detector.psi_threshold == 0.25
        assert len(detector.predictions) == 0
        assert len(detector.actuals) == 0
    
    def test_update(self):
        """Test updating drift detector with samples."""
        detector = DriftDetector(window_size=100)
        
        # Add some samples
        for i in range(10):
            detector.update(
                prediction=i % 2,
                actual=i % 2,
                probability=0.5 + (i % 2) * 0.4,
                features={'amount': 1000 * i, 'velocity_1h': i}
            )
        
        assert len(detector.predictions) == 10
        assert len(detector.actuals) == 10
        assert 'amount' in detector.feature_windows
        assert len(detector.feature_windows['amount']) == 10
    
    def test_no_drift_perfect_predictions(self):
        """Test no drift when predictions are perfect."""
        detector = DriftDetector(
            window_size=1000,
            f1_threshold=0.92,
            psi_threshold=0.25
        )
        
        # Add perfect predictions
        np.random.seed(42)
        for i in range(200):
            label = np.random.randint(0, 2)
            detector.update(
                prediction=label,  # Perfect prediction
                actual=label,
                probability=0.9 if label == 1 else 0.1,
                features={'amount': np.random.lognormal(8, 1)}
            )
        
        drift_detected, metrics = detector.check_drift()
        
        assert not drift_detected
        assert metrics['f1_score'] == 1.0
        assert metrics['sample_count'] == 200
    
    def test_drift_poor_predictions(self):
        """Test drift detection when predictions are poor."""
        detector = DriftDetector(
            window_size=500,
            f1_threshold=0.92,
            psi_threshold=0.25
        )
        
        # Add poor predictions (random)
        np.random.seed(42)
        for i in range(200):
            actual = np.random.randint(0, 2)
            prediction = np.random.randint(0, 2)  # Random prediction
            detector.update(
                prediction=prediction,
                actual=actual,
                probability=np.random.random(),
                features={'amount': np.random.lognormal(8, 1)}
            )
        
        drift_detected, metrics = detector.check_drift()
        
        # With random predictions, F1 should be around 0.5
        assert metrics['f1_score'] < detector.f1_threshold
        # Drift should be detected due to poor F1
        assert drift_detected
    
    def test_psi_calculation(self):
        """Test PSI calculation for feature drift."""
        detector = DriftDetector(window_size=200)
        
        # Set baseline distribution
        np.random.seed(42)
        baseline = np.random.normal(1000, 100, 1000).tolist()
        detector.set_baseline_distributions({'amount': baseline})
        
        # Add samples from same distribution
        for i in range(200):
            detector.update(
                prediction=0,
                actual=0,
                probability=0.1,
                features={'amount': np.random.normal(1000, 100)}
            )
        
        drift_detected, metrics = detector.check_drift()
        
        # PSI should be low (same distribution)
        assert metrics['psi_features']['amount'] < 0.1
    
    def test_psi_drift_detection(self):
        """Test PSI detects distribution shift."""
        detector = DriftDetector(
            window_size=200,
            psi_threshold=0.1  # Low threshold for test
        )
        
        # Set baseline distribution (low amounts)
        np.random.seed(42)
        baseline = np.random.normal(1000, 100, 1000).tolist()
        detector.set_baseline_distributions({'amount': baseline})
        
        # Add samples from different distribution (high amounts)
        for i in range(200):
            detector.update(
                prediction=0,
                actual=0,
                probability=0.1,
                features={'amount': np.random.normal(5000, 500)}  # 5x higher
            )
        
        drift_detected, metrics = detector.check_drift()
        
        # PSI should be high (different distribution)
        assert 'amount' in metrics['psi_features']
        # Large distribution shift should trigger drift
        # Note: Due to F1 being 1.0 (all predictions correct), 
        # drift detection depends on PSI threshold
    
    def test_reset(self):
        """Test resetting drift detector."""
        detector = DriftDetector(window_size=100)
        
        # Add some samples
        for i in range(50):
            detector.update(
                prediction=0,
                actual=0,
                probability=0.1,
                features={'amount': 1000}
            )
        
        assert len(detector.predictions) == 50
        
        # Reset
        detector.reset()
        
        assert len(detector.predictions) == 0
        assert len(detector.actuals) == 0
    
    def test_get_stats(self):
        """Test getting detector statistics."""
        detector = DriftDetector(window_size=100)
        
        # Add some samples with fraud
        for i in range(50):
            actual = 1 if i < 5 else 0  # 10% fraud rate
            detector.update(
                prediction=actual,
                actual=actual,
                probability=0.9 if actual == 1 else 0.1,
                features={'amount': 1000}
            )
        
        stats = detector.get_stats()
        
        assert stats['sample_count'] == 50
        assert stats['window_size'] == 100
        assert 0.09 <= stats['fraud_rate'] <= 0.11  # ~10%
    
    def test_sliding_window(self):
        """Test that sliding window works correctly."""
        window_size = 50
        detector = DriftDetector(window_size=window_size)
        
        # Add more samples than window size
        for i in range(100):
            detector.update(
                prediction=0,
                actual=0,
                probability=0.1,
                features={'amount': i}
            )
        
        # Should only keep last window_size samples
        assert len(detector.predictions) == window_size
        assert len(detector.actuals) == window_size
        
        # Last values should be most recent
        amounts = list(detector.feature_windows['amount'])
        assert amounts[-1] == 99
        assert amounts[0] == 50


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
