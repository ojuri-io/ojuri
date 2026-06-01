"""Calibrator improves Brier score on a synthetic bimodal distribution
(common XGBoost shape) where raw scores cluster near 0 and 1."""

import numpy as np
import pytest

from src.training.calibration import Calibrator, brier_score


def _synthetic_bimodal(seed: int = 0):
    rng = np.random.default_rng(seed)
    n = 2000
    y_true = rng.integers(0, 2, size=n)
    raw = np.where(
        y_true == 1,
        np.clip(rng.normal(0.95, 0.05, n), 0.0, 1.0),
        np.clip(rng.normal(0.04, 0.04, n), 0.0, 1.0),
    )
    miscalibrated = np.where(
        y_true == 1,
        np.clip(rng.normal(0.85, 0.10, n), 0.0, 1.0),
        np.clip(rng.normal(0.20, 0.10, n), 0.0, 1.0),
    )
    return y_true, miscalibrated, raw


def test_calibrator_reduces_brier():
    y_true, miscalibrated, _ = _synthetic_bimodal()
    cal = Calibrator().fit(miscalibrated, y_true)
    calibrated = cal.transform(miscalibrated)
    before = brier_score(y_true, miscalibrated)
    after = brier_score(y_true, calibrated)
    assert after < before, f"Brier did not improve: {before:.4f} → {after:.4f}"


def test_calibrator_roundtrip_through_disk(tmp_path):
    y_true, miscalibrated, _ = _synthetic_bimodal(seed=1)
    cal = Calibrator().fit(miscalibrated, y_true)
    out = tmp_path / "calibrator.npz"
    cal.save(out)
    reloaded = Calibrator.load(out)
    expected = cal.transform(miscalibrated)
    actual = reloaded.transform(miscalibrated)
    np.testing.assert_allclose(actual, expected, atol=1e-9)


def test_transform_before_fit_raises():
    with pytest.raises(RuntimeError):
        Calibrator().transform(np.array([0.5]))
