"""
Dead-letter sink for blocked-transaction events FIA cannot process.

Without it, a message that fails MAX_RETRIES times has its offset
committed and is gone: the transaction was declined, an investigation
report was owed, and no trace of the failure survives outside a log line.
"""

import json
import logging
from typing import Any, Dict, Optional

from kafka import KafkaProducer

logger = logging.getLogger(__name__)


class DlqProducer:
    def __init__(self, config):
        self._config = config
        self._producer: Optional[KafkaProducer] = None
        self._enabled = bool(config.KAFKA_DLQ_TOPIC)
        if not self._enabled:
            logger.warning("DLQ disabled (KAFKA_DLQ_TOPIC empty) — poison messages will be dropped")

    def _connect(self) -> Optional[KafkaProducer]:
        if self._producer is not None:
            return self._producer
        try:
            self._producer = KafkaProducer(
                bootstrap_servers=self._config.KAFKA_BROKERS,
                value_serializer=lambda v: json.dumps(v, default=str).encode("utf-8"),
                key_serializer=lambda k: k.encode("utf-8") if k else None,
                acks="all",
                retries=3,
            )
        except Exception as e:
            logger.error("Could not create DLQ producer: %s", e)
            self._producer = None
        return self._producer

    def publish(self, event: Dict[str, Any], stage: str, error: str, attempts: int) -> bool:
        """Best-effort. A DLQ failure must not wedge the partition — the
        caller has already exhausted its retries."""
        if not self._enabled:
            return False

        producer = self._connect()
        if producer is None:
            return False

        txn_id = event.get("transaction_id")
        try:
            producer.send(
                self._config.KAFKA_DLQ_TOPIC,
                key=txn_id,
                value={
                    "transaction_id": txn_id,
                    "failure_stage": stage,
                    "error": error,
                    "attempts": attempts,
                    "original_event": event,
                },
            ).get(timeout=10)
            logger.error("Published poison message to DLQ: txn=%s stage=%s", txn_id, stage)
            return True
        except Exception as e:
            logger.error("DLQ publish failed for txn=%s: %s", txn_id, e)
            return False

    def close(self) -> None:
        if self._producer is not None:
            try:
                self._producer.flush(timeout=5)
                self._producer.close(timeout=5)
            except Exception as e:
                logger.warning("DLQ producer close failed: %s", e)
            self._producer = None
