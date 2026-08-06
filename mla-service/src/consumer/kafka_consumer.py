"""
Kafka consumer for transaction monitoring.
Handles label delay and drift detection.
"""

from kafka import KafkaConsumer
import json
import logging
from typing import Callable

from src.config import config
from src.utils.logger import get_logger

logger = get_logger()  # Use the configured MLA logger

# TransactionEvent fields usable for PSI monitoring. Names must match
# `models/feature-catalog.v1.json` exactly — the baseline distributions
# are keyed by catalogue name and PSI only compares features present in
# BOTH baseline and window. The event does not carry the PAA-computed
# velocity/graph features, so they cannot be monitored here.
PSI_FEATURE_FIELDS = ('amount', 'account_age_days', 'session_to_txn_seconds')


def _first_present(payload: dict, *keys):
    """First key actually present, preserving falsy values."""
    for key in keys:
        if key in payload:
            return payload[key]
    return None


def extract_psi_features(transaction: dict) -> dict:
    """
    Pull PSI-monitorable features from a transaction event. Absent
    fields are omitted rather than defaulted — a fabricated constant 0
    poisons the window with a distribution the model never saw.
    """
    features = {}
    for field in PSI_FEATURE_FIELDS:
        value = transaction.get(field)
        if value is None:
            continue
        try:
            features[field] = float(value)
        except (TypeError, ValueError):
            continue
    return features


class KafkaConsumerService:
    """
    Consume transaction events from Kafka and monitor for drift.
    
    CRITICAL: FRAUD LABEL DELAY HANDLING
    ═══════════════════════════════════════════════════════════════
    Fraud labels are NOT immediately available in production systems.
    
    Timeline:
    - Day 1: Transaction occurs → RDA predicts → fraud_label = NULL
    - Day 3-7: Customer complains OR chargeback → fraud_label = TRUE/FALSE
    - Day 7+: MLA uses labeled data for drift monitoring
    
    This means:
    1. Most Kafka messages will have fraud_label = NULL (expected!)
    2. Drift detector only updates when fraud_label IS NOT NULL
    3. Drift detection works on 3-7 day delayed data (acceptable!)
    
    The delay does NOT hurt drift detection because:
    - Drift is a gradual process (happens over days/weeks)
    - 7-day delay is negligible compared to drift timescales
    - Having accurate labels is more important than speed
    ═══════════════════════════════════════════════════════════════
    """
    
    def __init__(self, config, drift_detector):
        """
        Initialize Kafka consumer.
        
        Args:
            config: Configuration object
            drift_detector: DriftDetector instance
        """
        self._config = config
        self.drift_detector = drift_detector
        self.consumer = None
        self._connected = False
        
        self._try_connect()
    
    def _try_connect(self):
        """Attempt to connect to Kafka."""
        try:
            self.consumer = KafkaConsumer(
                self._config.KAFKA_TOPIC,
                group_id=self._config.KAFKA_CONSUMER_GROUP,
                bootstrap_servers=self._config.KAFKA_BROKERS,
                auto_offset_reset='latest',
                enable_auto_commit=False,  # Manual commit for reliability
                value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                consumer_timeout_ms=1000,  # 1 second timeout for polling
                session_timeout_ms=10000,  # 10 second session timeout (faster dead consumer detection)
                heartbeat_interval_ms=3000  # 3 second heartbeat
            )
            
            self._connected = True
            
            logger.info(f"✅ Kafka consumer initialized")
            logger.info(f"   Topic: {self._config.KAFKA_TOPIC}")
            logger.info(f"   Group: {self._config.KAFKA_CONSUMER_GROUP}")
            logger.info(f"   Brokers: {self._config.KAFKA_BROKERS}")
            
        except Exception as e:
            logger.warning(f"⚠️  Kafka consumer initialization failed: {e}")
            logger.warning("   Running in standalone mode (no real-time drift monitoring)")
            self._connected = False
    
    def is_connected(self) -> bool:
        """Check if Kafka is connected."""
        return self._connected
    
    def consume_and_monitor(self, callback_on_drift: Callable):
        """
        Main consumption loop with drift monitoring.
        
        Args:
            callback_on_drift: Function to call when drift detected
        """
        if not self._connected:
            logger.warning("Kafka not connected - cannot consume messages")
            logger.warning("Running in manual training mode")
            return
        
        logger.info("Starting Kafka consumption...")
        logger.info("")
        logger.info("⚠️  FRAUD LABEL DELAY NOTICE:")
        logger.info("   Most messages will have fraud_label = NULL")
        logger.info("   This is expected - labels arrive 3-7 days later")
        logger.info("   Drift detector only updates when labels available")
        logger.info("")
        
        labeled_count = 0
        unlabeled_count = 0
        drift_check_count = 0
        poll_count = 0
        
        try:
            while True:
                try:
                    # Poll for messages with timeout
                    message_batch = self.consumer.poll(timeout_ms=1000)
                    poll_count += 1
                    
                    # Heartbeat log every 10 polls (10 seconds)
                    if poll_count % 10 == 0:
                        total = labeled_count + unlabeled_count
                        logger.debug(f"⏳ Poll #{poll_count}: {total} messages so far ({labeled_count} labeled)")
                    
                    if not message_batch:
                        continue
                    
                    for topic_partition, messages in message_batch.items():
                        logger.info(f"📨 Received {len(messages)} messages from {topic_partition}")
                        for message in messages:
                            try:
                                # Parse transaction
                                transaction = message.value
                                
                                # Extract fields
                                transaction_id = _first_present(
                                    transaction, 'transaction_id', 'transactionId'
                                )
                                fraud_prediction = int(transaction.get('fraud', False))
                                fraud_probability = _first_present(
                                    transaction, 'fraud_probability', 'fraudProbability'
                                ) or 0.0
                                # `or` would collapse a legitimate
                                # False/0 label to the next key and then
                                # to None, so only fraud=True labels
                                # would ever reach the drift window —
                                # F1 computed over a single class.
                                fraud_label = _first_present(
                                    transaction, 'fraud_label', 'fraudLabel'
                                )
                                
                                # Log every message for debugging (first 10, then every 100th)
                                total = labeled_count + unlabeled_count
                                if total < 10 or total % 100 == 0:
                                    logger.info(
                                        f"📥 Message received: {transaction_id} | "
                                        f"fraud={fraud_prediction} | prob={fraud_probability:.4f} | "
                                        f"label={'YES' if fraud_label else 'NO' if fraud_label is False else 'PENDING'}"
                                    )
                                
                                features = extract_psi_features(transaction)
                                
                                # Update drift detector ONLY if we have ground truth label
                                if fraud_label is not None:
                                    self.drift_detector.update(
                                        prediction=fraud_prediction,
                                        actual=int(fraud_label),
                                        probability=float(fraud_probability),
                                        features=features
                                    )
                                    labeled_count += 1
                                else:
                                    # No label yet - can't use for drift monitoring
                                    unlabeled_count += 1
                                
                                # Log stats every 1000 messages
                                total_count = labeled_count + unlabeled_count
                                if total_count > 0 and total_count % 1000 == 0:
                                    label_rate = labeled_count / total_count * 100 if total_count > 0 else 0
                                    logger.info(
                                        f"Processed {total_count:,} messages: "
                                        f"{labeled_count:,} labeled ({label_rate:.1f}%), "
                                        f"{unlabeled_count:,} unlabeled"
                                    )
                                
                                # Check for drift every 100 labeled messages
                                if labeled_count > 0 and labeled_count % 100 == 0:
                                    drift_check_count += 1
                                    
                                    drift_detected, metrics = self.drift_detector.check_drift()
                                    
                                    if drift_detected:
                                        logger.warning("=" * 70)
                                        logger.warning("🚨 DRIFT DETECTED!")
                                        logger.warning(f"   F1-score: {metrics.get('f1_score', 0):.4f}")
                                        logger.warning(f"   Max PSI: {metrics.get('max_psi', 0):.4f}")
                                        logger.warning(f"   Reasons: {metrics.get('drift_reasons', [])}")
                                        logger.warning("=" * 70)
                                        
                                        # Trigger retraining callback
                                        callback_on_drift(metrics)
                                    else:
                                        # Log drift check results
                                        if drift_check_count % 10 == 0:  # Every 10 checks
                                            logger.debug(
                                                f"Drift check #{drift_check_count}: "
                                                f"F1={metrics.get('f1_score', 0):.4f}, "
                                                f"PSI={metrics.get('max_psi', 0):.4f}"
                                            )
                                
                            except Exception as e:
                                logger.error(f"Error processing message: {e}", exc_info=True)
                    
                    # Commit offset after successful processing
                    if message_batch:
                        self.consumer.commit()
                
                except StopIteration:
                    # No more messages in this poll
                    continue
        
        except KeyboardInterrupt:
            logger.info("Kafka consumption interrupted by user")
        
        finally:
            logger.info(f"Kafka consumption stopped")
            logger.info(f"  Total messages: {labeled_count + unlabeled_count:,}")
            logger.info(f"  Labeled: {labeled_count:,}")
            logger.info(f"  Unlabeled: {unlabeled_count:,}")
            logger.info(f"  Drift checks performed: {drift_check_count}")
    
    def close(self):
        """Gracefully close consumer."""
        if self.consumer:
            try:
                self.consumer.close()
                logger.info("Kafka consumer closed")
            except Exception as e:
                logger.error(f"Error closing consumer: {e}")
