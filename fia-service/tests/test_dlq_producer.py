"""
After MAX_RETRIES failures FIA committed the offset and the message was
gone — no DLQ. The transaction had already been declined and an
investigation report was owed, so the loss is silent and unrecoverable.

Run from the MLA venv (kafka-python is shared):
    cd mla-service && source venv/bin/activate && \
      python -m pytest ../fia-service/tests -q
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.consumer.dlq_producer import DlqProducer


class FakeConfig:
    KAFKA_BROKERS = ["localhost:9092"]
    KAFKA_DLQ_TOPIC = "transactions.blocked.dlq"


class DisabledConfig(FakeConfig):
    KAFKA_DLQ_TOPIC = ""


EVENT = {"transaction_id": "txn-1", "decision": "DECLINE", "amount": 500}


@pytest.fixture
def producer_cls():
    with patch("src.consumer.dlq_producer.KafkaProducer") as cls:
        cls.return_value.send.return_value = MagicMock()
        yield cls


class TestDlqProducer:
    def test_publishes_the_original_event_with_failure_context(self, producer_cls):
        dlq = DlqProducer(FakeConfig())
        assert dlq.publish(EVENT, "generation", "boom", 3) is True

        _, kwargs = producer_cls.return_value.send.call_args
        args, _ = producer_cls.return_value.send.call_args
        assert args[0] == "transactions.blocked.dlq"
        assert kwargs["key"] == "txn-1"
        assert kwargs["value"]["failure_stage"] == "generation"
        assert kwargs["value"]["error"] == "boom"
        assert kwargs["value"]["attempts"] == 3
        assert kwargs["value"]["original_event"] == EVENT

    def test_keys_by_transaction_id_so_a_replay_stays_ordered(self, producer_cls):
        DlqProducer(FakeConfig()).publish(EVENT, "persistence", "err", 3)
        _, kwargs = producer_cls.return_value.send.call_args
        assert kwargs["key"] == EVENT["transaction_id"]

    def test_reports_false_when_disabled(self, producer_cls):
        assert DlqProducer(DisabledConfig()).publish(EVENT, "generation", "boom", 3) is False
        producer_cls.assert_not_called()

    def test_a_broker_failure_does_not_raise_into_the_consumer(self, producer_cls):
        producer_cls.return_value.send.side_effect = RuntimeError("broker down")
        assert DlqProducer(FakeConfig()).publish(EVENT, "generation", "boom", 3) is False

    def test_a_connect_failure_does_not_raise_into_the_consumer(self, producer_cls):
        producer_cls.side_effect = RuntimeError("no brokers")
        assert DlqProducer(FakeConfig()).publish(EVENT, "generation", "boom", 3) is False

    def test_reuses_one_producer_across_publishes(self, producer_cls):
        dlq = DlqProducer(FakeConfig())
        dlq.publish(EVENT, "generation", "a", 3)
        dlq.publish(EVENT, "generation", "b", 3)
        assert producer_cls.call_count == 1

    def test_close_is_safe_before_any_publish(self, producer_cls):
        DlqProducer(FakeConfig()).close()
