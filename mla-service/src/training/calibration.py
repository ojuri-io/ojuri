"""Isotonic calibration for XGBoost fraud-score outputs.

XGBoost produces sigmoid-of-margin scores that empirically cluster
near 0 and 1, leaving the [0.05, 0.95] band underpopulated. Isotonic
regression maps the raw scores onto observed fraud rates so threshold
tuning behaves linearly and the Brier score is meaningful.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss

logger = logging.getLogger(__name__)


class Calibrator:
    def __init__(self) -> None:
        self._iso: Optional[IsotonicRegression] = None

    @property
    def fitted(self) -> bool:
        return self._iso is not None

    def fit(self, uncalibrated_scores: np.ndarray, y_true: np.ndarray) -> "Calibrator":
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(np.asarray(uncalibrated_scores).ravel(), np.asarray(y_true).ravel())
        self._iso = iso
        return self

    def transform(self, uncalibrated_scores: np.ndarray) -> np.ndarray:
        if self._iso is None:
            raise RuntimeError("Calibrator.transform called before fit()")
        return self._iso.transform(np.asarray(uncalibrated_scores).ravel())

    def as_breakpoints(self) -> dict:
        """JSON-serialisable form for meta.json. RDA applies the mapping
        at inference from these; the paired .npz stays numpy-native and
        is not readable from Node."""
        if self._iso is None:
            raise RuntimeError("Calibrator.as_breakpoints called before fit()")
        return {
            "x_thresholds": [float(v) for v in self._iso.X_thresholds_],
            "y_thresholds": [float(v) for v in self._iso.y_thresholds_],
        }

    def save(self, path: Path) -> None:
        if self._iso is None:
            raise RuntimeError("Calibrator.save called before fit()")
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            x_thresholds=self._iso.X_thresholds_,
            y_thresholds=self._iso.y_thresholds_,
            increasing=np.array([1 if self._iso.increasing_ else 0]),
        )

    @classmethod
    def load(cls, path: Path) -> "Calibrator":
        data = np.load(Path(path))
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.X_thresholds_ = data["x_thresholds"]
        iso.y_thresholds_ = data["y_thresholds"]
        iso.X_min_ = float(iso.X_thresholds_.min())
        iso.X_max_ = float(iso.X_thresholds_.max())
        iso.increasing_ = bool(data["increasing"][0])
        # sklearn's transform() reads f_ (an interp1d built at fit time);
        # restoring only thresholds is not enough.
        iso._build_f(iso.X_thresholds_, iso.y_thresholds_)
        calibrator = cls()
        calibrator._iso = iso
        return calibrator


def brier_score(y_true: np.ndarray, scores: np.ndarray) -> float:
    return float(brier_score_loss(np.asarray(y_true), np.asarray(scores)))
