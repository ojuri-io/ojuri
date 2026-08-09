"""
Isotonic calibration maps raw scores onto observed fraud rates, so the
split it fits on has to carry the real base rate. It was carved *after*
SMOTE and context-dropout augmentation, so it saw a ~50% synthetic fraud
rate and the mapping targeted an oversampled prior. Cross-validation had
the mirrored problem: scored on post-SMOTE data, synthetic points
interpolated from a training row landed in the validation fold.
"""

import numpy as np
import pandas as pd
import pytest

from src.training.preprocessor import DataPreprocessor
from src.training.splits import PreprocessedSplits


def _imbalanced_frame(n=4000, fraud_rate=0.05):
    rng = np.random.default_rng(42)
    n_fraud = int(n * fraud_rate)
    y = np.concatenate([np.zeros(n - n_fraud), np.ones(n_fraud)]).astype(int)
    rng.shuffle(y)
    X = pd.DataFrame(
        rng.random((n, 12)).astype(np.float32),
        columns=[f"f{i}" for i in range(12)],
    )
    # Give the label some signal so SMOTE and the booster have something
    # to work with.
    X.loc[y == 1, "f0"] += 1.5
    return X, pd.Series(y)


class TestCalibrationSplit:
    def test_returns_structured_splits(self):
        X, y = _imbalanced_frame()
        splits = DataPreprocessor().preprocess(X, y)
        assert isinstance(splits, PreprocessedSplits)

    def test_calibration_holdout_is_non_empty(self):
        X, y = _imbalanced_frame()
        splits = DataPreprocessor().preprocess(X, y)
        assert len(splits.X_cal) > 0
        assert len(splits.X_cal) == len(splits.y_cal)

    def test_calibration_split_keeps_the_real_fraud_rate(self):
        """The defect: post-SMOTE the fit set is ~50% fraud. The
        calibration slice must stay near the natural rate."""
        X, y = _imbalanced_frame(fraud_rate=0.05)
        splits = DataPreprocessor().preprocess(X, y)

        train_rate = splits.y_train.mean()
        cal_rate = splits.y_cal.mean()

        assert train_rate > 0.3, "expected SMOTE to rebalance the fit set"
        assert cal_rate < 0.2, f"calibration split is oversampled: {cal_rate}"

    def test_calibration_rows_are_not_also_trained_on(self):
        X, y = _imbalanced_frame()
        splits = DataPreprocessor().preprocess(X, y)

        fit_rows = {r.tobytes() for r in splits.X_fit_raw}
        cal_rows = {r.tobytes() for r in splits.X_cal}
        assert fit_rows.isdisjoint(cal_rows)

    def test_cv_arrays_are_pre_augmentation(self):
        X, y = _imbalanced_frame()
        splits = DataPreprocessor().preprocess(X, y)

        assert len(splits.X_fit_raw) < len(splits.X_train)
        assert splits.y_fit_raw.mean() < 0.2

    def test_small_datasets_skip_calibration_rather_than_fabricate_one(self):
        rng = np.random.default_rng(0)
        X = pd.DataFrame(rng.random((100, 5)).astype(np.float32))
        y = pd.Series(rng.integers(0, 2, 100))
        splits = DataPreprocessor().preprocess(X, y)
        assert len(splits.X_cal) == 0

    def test_legacy_tuple_unpacking_still_works(self):
        X, y = _imbalanced_frame()
        X_train, X_val, X_test, y_train, y_val, y_test = DataPreprocessor().preprocess(X, y)
        assert X_train.shape[1] == X_val.shape[1] == X_test.shape[1]
        assert len(X_train) == len(y_train)
