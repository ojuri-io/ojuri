"""
Kafka consumer for the `transactions.blocked` topic.

Each message is a TransactionEvent published by RDA when its decision is
DECLINE. The consumer hands the parsed event to the FIA pipeline and only
commits the offset of the *specific* partition it just processed, so a crash
mid-flight only re-processes that one event (idempotency is enforced by the
unique transaction_id constraint in `investigationReports`).

Design notes:
- ``max_poll_records=1`` and ``max_poll_interval_ms`` is set well above the
  worst-case LLM latency. The Phi-3 generator runs synchronously inside the
  message handler; without these, a slow LLM call would exceed the consumer
  group's poll interval and trigger a rebalance.
- Per-partition explicit commit avoids the trap of ``consumer.commit()``
  with no arguments, which advances the offset of *all* assigned partitions
  to the last consumed position (across partitions).
- ``consumer_timeout_ms`` is intentionally NOT set; ``poll()`` is used
  directly so the iterator-style timeout behaviour does not apply.
"""

import json
from typing import Callable, Optional

from kafka import KafkaConsumer
from kafka.errors import CommitFailedError, KafkaError
from kafka.structs import OffsetAndMetadata, TopicPartition

from src.utils.logger import get_logger

logger = get_logger("FIA.kafka")


class BlockedTransactionConsumer:
    def __init__(self, config):
        self._config = config
        self._consumer: Optional[KafkaConsumer] = None
        self._connected = False
        self._stop = False
        self._try_connect()

    def _try_connect(self) -> None:
        try:
            self._consumer = KafkaConsumer(
                self._config.KAFKA_BLOCKED_TOPIC,
                group_id=self._config.KAFKA_CONSUMER_GROUP,
                bootstrap_servers=self._config.KAFKA_BROKERS,
                auto_offset_reset=self._config.KAFKA_AUTO_OFFSET_RESET,
                enable_auto_commit=False,
                value_deserializer=lambda m: json.loads(m.decode("utf-8")),
                # One message per poll - LLM generation is the bottleneck and
                # we don't want to block other partitions waiting for one slow call.
                max_poll_records=1,
                # Allow up to 10 minutes between polls so a slow LLM call doesn't
                # trigger a group rebalance. Heartbeats run on a separate thread.
                max_poll_interval_ms=600000,
                session_timeout_ms=30000,
                heartbeat_interval_ms=10000,
            )
            self._connected = True
            logger.info(
                "Kafka consumer ready (topic=%s group=%s brokers=%s)",
                self._config.KAFKA_BLOCKED_TOPIC,
                self._config.KAFKA_CONSUMER_GROUP,
                self._config.KAFKA_BROKERS,
            )
        except KafkaError as e:
            logger.warning("Kafka unavailable: %s. Service will idle until restart.", e)
            self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    def stop(self) -> None:
        self._stop = True

    def consume(self, handler: Callable[[dict], bool]) -> None:
        """
        Main poll loop. ``handler`` returns True on success (commit offset),
        False on failure (skip commit so the message is re-delivered).

        Offsets are committed per-partition so a failure on one partition
        does not advance offsets on others.
        """
        if not self._connected or self._consumer is None:
            logger.error("Consumer not connected; cannot start consume loop")
            return

        logger.info("Starting consume loop")
        try:
            while not self._stop:
                batch = self._consumer.poll(timeout_ms=1000)
                if not batch:
                    continue
                for tp, messages in batch.items():
                    for msg in messages:
                        try:
                            success = handler(msg.value)
                        except Exception as e:
                            logger.error(
                                "Handler raised on %s/%s offset=%s: %s",
                                tp.topic, tp.partition, msg.offset, e,
                                exc_info=True,
                            )
                            success = False

                        if not success:
                            logger.warning(
                                "Skipping commit for %s/%s offset=%s (will retry on next poll)",
                                tp.topic, tp.partition, msg.offset,
                            )
                            continue

                        # Commit ONLY the partition we just processed, advancing to next offset.
                        try:
                            self._consumer.commit(
                                {tp: OffsetAndMetadata(msg.offset + 1, None)}
                            )
                        except CommitFailedError as e:
                            # Triggered by rebalance during processing. The new owner
                            # of this partition will re-deliver this offset; idempotency
                            # in the writer covers the duplicate.
                            logger.warning(
                                "Commit failed for %s/%s offset=%s (likely rebalance): %s",
                                tp.topic, tp.partition, msg.offset, e,
                            )
        finally:
            self.close()

    def close(self) -> None:
        if self._consumer is not None:
            try:
                self._consumer.close()
                logger.info("Kafka consumer closed")
            except Exception as e:
                logger.error("Error closing consumer: %s", e)
        self._connected = False


__all__ = ["BlockedTransactionConsumer", "TopicPartition"]
