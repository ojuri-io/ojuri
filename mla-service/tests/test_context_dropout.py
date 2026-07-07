"""Context-field dropout augmentation (efficacy-validation finding F3).

The model was scoring bare payloads as blanket fraud because training
data coupled fraud with the presence/values of optional context fields.
Dropout appends copies of training rows with those fields zeroed, labels
kept, so the model must find signal in behaviour rather than context
presence.
"""

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.config import config
from src.training.preprocessor import DataPreprocessor, CONTEXT_FEATURE_NAMES


def _frame(n=100):
    cols = ["velocity_1h", "amount"] + list(CONTEXT_FEATURE_NAMES)
    data = {c: np.arange(1, n + 1, dtype=float) for c in cols}
    return pd.DataFrame(data)


def test_resolve_context_indices_matches_columns():
    pre = DataPreprocessor()
    X = _frame()
    idx = pre._resolve_context_indices(X)
    assert len(idx) == len(CONTEXT_FEATURE_NAMES)
    assert idx == [X.columns.get_loc(n) for n in CONTEXT_FEATURE_NAMES]


def test_dropout_appends_bare_rows_and_zeros_context():
    pre = DataPreprocessor()
    X = _frame(100)
    idx = pre._resolve_context_indices(X)
    Xa = X.values.astype(np.float32)
    ya = np.zeros(len(Xa), dtype=np.int32)

    prev = config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION
    config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = True, 0.4
    try:
        Xo, yo = pre._augment_context_dropout(Xa, ya, idx)
    finally:
        config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = prev

    assert len(Xo) == 140          # 100 + 40% appended
    assert len(yo) == 140
    added = Xo[100:]
    assert np.all(added[:, idx] == 0.0)          # context zeroed
    non_ctx = [i for i in range(Xa.shape[1]) if i not in idx]
    assert np.any(added[:, non_ctx] != 0.0)      # behaviour preserved


def test_dropout_preserves_labels_of_source_rows():
    pre = DataPreprocessor()
    X = _frame(50)
    idx = pre._resolve_context_indices(X)
    Xa = X.values.astype(np.float32)
    ya = (np.arange(len(Xa)) % 2).astype(np.int32)

    prev = config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION
    config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = True, 1.0
    try:
        Xo, yo = pre._augment_context_dropout(Xa, ya, idx)
    finally:
        config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = prev

    # fraction 1.0 with replace=False appends a permutation of all rows;
    # label multiset must double exactly.
    assert len(Xo) == 100
    assert int(yo.sum()) == 2 * int(ya.sum())


def test_dropout_disabled_is_noop():
    pre = DataPreprocessor()
    X = _frame(30)
    idx = pre._resolve_context_indices(X)
    Xa = X.values.astype(np.float32)
    ya = np.zeros(len(Xa), dtype=np.int32)

    prev = config.CONTEXT_DROPOUT_ENABLED
    config.CONTEXT_DROPOUT_ENABLED = False
    try:
        Xo, yo = pre._augment_context_dropout(Xa, ya, idx)
    finally:
        config.CONTEXT_DROPOUT_ENABLED = prev
    assert len(Xo) == 30 and len(yo) == 30


def test_dropout_deterministic():
    pre = DataPreprocessor()
    X = _frame(80)
    idx = pre._resolve_context_indices(X)
    Xa = X.values.astype(np.float32)
    ya = np.zeros(len(Xa), dtype=np.int32)

    prev = config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION
    config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = True, 0.5
    try:
        a, _ = pre._augment_context_dropout(Xa, ya, idx)
        b, _ = pre._augment_context_dropout(Xa, ya, idx)
    finally:
        config.CONTEXT_DROPOUT_ENABLED, config.CONTEXT_DROPOUT_FRACTION = prev
    assert np.array_equal(a, b)
