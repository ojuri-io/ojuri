"""
Poison-message accounting: the offset is only committed once retries are
exhausted, and the exhausted message must reach the DLQ before that
commit rather than vanishing.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class StubService:
    """Mirrors FIA's retry bookkeeping without importing torch/transformers."""

    def __init__(self, dlq, max_retries=3):
        self._dlq = dlq
        self._max_retries = max_retries
        self._retry_counts = {}
        self._failed = 0
        self._dropped_poison = 0
        self._dlq_published = 0

    _record_failure = None  # bound below


def _load_record_failure():
    """Pull the real implementation out of main.py by source, so the test
    tracks the shipped logic without importing the LLM stack."""
    import ast
    import textwrap

    path = os.path.join(os.path.dirname(__file__), "..", "src", "main.py")
    with open(path) as f:
        tree = ast.parse(f.read())

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_record_failure":
            module = ast.Module(body=[node], type_ignores=[])
            from typing import Any, Dict, Optional

            ns = {"logger": MagicMock(), "Optional": Optional, "Dict": Dict, "Any": Any}
            exec(compile(module, path, "exec"), ns)
            return ns["_record_failure"]
    raise AssertionError("_record_failure not found in src/main.py")


@pytest.fixture
def record_failure():
    return _load_record_failure()


EVENT = {"transaction_id": "txn-1", "decision": "DECLINE"}


class TestPoisonHandling:
    def test_keeps_the_offset_uncommitted_while_retries_remain(self, record_failure):
        dlq = MagicMock()
        svc = StubService(dlq)

        assert record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT) is False
        assert record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT) is False
        dlq.publish.assert_not_called()

    def test_publishes_to_the_dlq_and_commits_once_retries_are_exhausted(self, record_failure):
        dlq = MagicMock()
        dlq.publish.return_value = True
        svc = StubService(dlq)

        for _ in range(2):
            record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT)
        committed = record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT)

        assert committed is True
        dlq.publish.assert_called_once()
        assert dlq.publish.call_args[0][0] == EVENT
        assert svc._dlq_published == 1
        assert svc._dropped_poison == 1

    def test_still_commits_when_the_dlq_itself_is_unavailable(self, record_failure):
        dlq = MagicMock()
        dlq.publish.return_value = False
        svc = StubService(dlq)

        for _ in range(2):
            record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT)
        assert record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT) is True
        assert svc._dlq_published == 0

    def test_clears_the_retry_counter_so_the_id_is_not_leaked(self, record_failure):
        dlq = MagicMock()
        svc = StubService(dlq)
        for _ in range(3):
            record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT)
        assert "txn-1" not in svc._retry_counts

    def test_tracks_transactions_independently(self, record_failure):
        dlq = MagicMock()
        svc = StubService(dlq)
        record_failure(svc, "txn-1", "generation", RuntimeError("x"), EVENT)
        record_failure(svc, "txn-2", "generation", RuntimeError("x"), EVENT)
        assert svc._retry_counts == {"txn-1": 1, "txn-2": 1}
