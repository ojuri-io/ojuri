"""
DRIFT_F1_THRESHOLD was a fixed 0.92 against a deploy gate of
MIN_DEPLOY_F1=0.3 and a measured realistic F1 of 0.554, so every check
would report drift — and the detector window was only cleared on a
*successful* deployment, so an A/B-rejected candidate left it full and
the next check tripped again immediately.
"""

import numpy as np
import pytest

from src.monitoring.drift_detector import DriftDetector


def _fill(detector, n=200, wrong_fraction=0.0):
    """Feed labelled samples; `wrong_fraction` of the fraud cases are
    missed, which is what pushes F1 down."""
    rng = np.random.default_rng(7)
    for i in range(n):
        actual = 1 if i % 4 == 0 else 0
        predicted = actual
        if actual == 1 and rng.random() < wrong_fraction:
            predicted = 0
        detector.update(
            prediction=predicted,
            actual=actual,
            probability=0.9 if predicted else 0.1,
            features={"amount": float(rng.random() * 1000)},
        )


class TestF1ThresholdCalibration:
    def test_anchors_to_champion_f1_minus_margin(self):
        d = DriftDetector(window_size=1000, f1_threshold=0.92)
        assert d.calibrate_f1_threshold(0.554, margin=0.05, floor=0.3) == pytest.approx(0.504)

    def test_never_drops_below_the_deploy_floor(self):
        d = DriftDetector(window_size=1000, f1_threshold=0.92)
        assert d.calibrate_f1_threshold(0.31, margin=0.20, floor=0.3) == pytest.approx(0.3)

    def test_keeps_the_configured_value_when_no_champion_metrics_exist(self):
        d = DriftDetector(window_size=1000, f1_threshold=0.4)
        assert d.calibrate_f1_threshold(None, margin=0.05, floor=0.3) == pytest.approx(0.4)
        assert d.calibrate_f1_threshold(0.0, margin=0.05, floor=0.3) == pytest.approx(0.4)

    def test_a_healthy_model_at_realistic_f1_does_not_trip_drift(self):
        """The regression: with the old 0.92 threshold this fired on a
        model performing exactly as deployed."""
        d = DriftDetector(window_size=1000, f1_threshold=0.92)
        _fill(d, n=200, wrong_fraction=0.35)
        drifted_before, metrics = d.check_drift()
        assert drifted_before is True

        d.calibrate_f1_threshold(metrics["f1_score"], margin=0.05, floor=0.3)
        drifted_after, _ = d.check_drift()
        assert drifted_after is False

    def test_still_fires_when_the_model_degrades_past_the_margin(self):
        d = DriftDetector(window_size=1000, f1_threshold=0.92)
        _fill(d, n=200, wrong_fraction=0.1)
        _, healthy = d.check_drift()
        d.calibrate_f1_threshold(healthy["f1_score"], margin=0.05, floor=0.3)

        d.reset()
        _fill(d, n=200, wrong_fraction=0.8)
        drifted, degraded = d.check_drift()
        assert drifted is True
        assert degraded["f1_score"] < healthy["f1_score"]


class TestDriftWindowReset:
    def test_reset_clears_the_window_so_the_next_check_starts_fresh(self):
        d = DriftDetector(window_size=1000, f1_threshold=0.92)
        _fill(d, n=200, wrong_fraction=0.9)
        assert d.check_drift()[0] is True

        d.reset()
        # Below min_samples, so the detector reports no drift rather than
        # re-tripping on samples that already triggered a retrain.
        assert d.check_drift()[0] is False
