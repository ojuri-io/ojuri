"""Dataset splits handed from the preprocessor to the trainer."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class PreprocessedSplits:
    """
    `X_train` / `y_train` are augmented (context dropout + SMOTE) and are
    the only arrays the booster fits on.

    `X_fit_raw` / `y_fit_raw` are the same rows *before* augmentation.
    Cross-validation runs on these with resampling applied inside each
    fold — scoring post-SMOTE data lets synthetic points interpolated
    from a training row land in the validation fold and inflates CV F1.

    `X_cal` / `y_cal` are carved off before any augmentation and are never
    fitted on. Isotonic calibration maps scores onto observed fraud
    rates, so it has to see the real base rate; fitting it on SMOTE'd
    rows targets an oversampled ~50% prior instead of the real one.
    """

    X_train: np.ndarray
    y_train: np.ndarray
    X_val: np.ndarray
    y_val: np.ndarray
    X_test: np.ndarray
    y_test: np.ndarray
    X_cal: np.ndarray
    y_cal: np.ndarray
    X_fit_raw: np.ndarray
    y_fit_raw: np.ndarray

    @classmethod
    def from_arrays(
        cls,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray,
        y_val: np.ndarray,
    ) -> "PreprocessedSplits":
        """Splits with no calibration holdout — for callers that already
        hold prepared arrays. Calibration is skipped rather than fitted
        on training rows."""
        empty_X = np.empty((0, X_train.shape[1]), dtype=X_train.dtype)
        empty_y = np.empty((0,), dtype=y_train.dtype)
        return cls(
            X_train=X_train,
            y_train=y_train,
            X_val=X_val,
            y_val=y_val,
            X_test=empty_X,
            y_test=empty_y,
            X_cal=empty_X,
            y_cal=empty_y,
            X_fit_raw=X_train,
            y_fit_raw=y_train,
        )

    def as_legacy_tuple(self):
        return (
            self.X_train,
            self.X_val,
            self.X_test,
            self.y_train,
            self.y_val,
            self.y_test,
        )

    # Keeps `X_train, X_val, X_test, y_train, y_val, y_test = preprocess(...)`
    # working at the call sites that only need the six arrays.
    def __iter__(self):
        return iter(self.as_legacy_tuple())

    def __len__(self) -> int:
        return len(self.as_legacy_tuple())
