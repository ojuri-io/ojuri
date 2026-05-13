"""
Fraud Investigation Agent (FIA) entry point.

Pipeline:
1. Consume `transactions.blocked` from Kafka (published by RDA on DECLINE).
2. For each event, generate a structured investigation report via Phi-3.
3. Persist the report into PostgreSQL `investigationReports`.
4. Commit Kafka offset only after a successful (or idempotently-skipped) write.

Operates fully asynchronously - never on the real-time authorization path.
"""

import http.server
import json
import signal
import socketserver
import sys
import threading
from typing import Any, Dict, Optional  # noqa: F401  (Dict used by retry counter)

from src.config import config
from src.consumer.kafka_consumer import BlockedTransactionConsumer
from src.llm.phi3_generator import Phi3ReportGenerator
from src.persistence.report_writer import ReportWriter
from src.utils.database import DatabaseConnection
from src.utils.logger import setup_logger

logger = setup_logger("FIA", config.LOG_LEVEL)


class FIAService:
    def __init__(self):
        logger.info("=" * 70)
        logger.info("FRAUD INVESTIGATION AGENT STARTING")
        logger.info("=" * 70)

        self._db = DatabaseConnection(config)
        self._writer = ReportWriter(self._db)
        self._generator = Phi3ReportGenerator(config)
        self._consumer = BlockedTransactionConsumer(config)

        self._processed = 0
        self._failed = 0
        self._duplicates = 0
        self._dropped_poison = 0
        # Bounded in-memory retry counter per transaction_id. Prevents a
        # genuinely poisonous message from looping forever and blocking the
        # partition. After MAX_RETRIES failures we treat the offset as
        # processed (committed) and log loudly; in production this should be
        # routed to a real DLQ topic.
        self._retry_counts: Dict[str, int] = {}
        self._max_retries = 3

        self._health_server: Optional[socketserver.TCPServer] = None
        self._health_thread: Optional[threading.Thread] = None

        logger.info("FIA components initialized (llm=%s)", self._generator.model_version())

    # ────────────────────────────────────────────────────────────
    # Message handler
    # ────────────────────────────────────────────────────────────
    def handle(self, event: Dict[str, Any]) -> bool:
        """
        Process one blocked-transaction event. Returns True if it is safe to
        commit the Kafka offset (success or idempotent duplicate). Returns
        False to keep the offset uncommitted so the message is re-delivered.
        """
        txn_id = event.get("transaction_id")
        if not txn_id:
            logger.error("Event missing transaction_id, dropping: %s", json.dumps(event)[:300])
            return True  # No retry value in this message — safe to skip.

        # Defensive: only investigate decisions that were actually a DECLINE.
        decision = (event.get("decision") or "").upper()
        if decision != "DECLINE":
            logger.debug("Skipping non-DECLINE event %s (decision=%s)", txn_id, decision)
            return True

        try:
            report, latency_ms = self._generator.generate(event)
        except Exception as e:
            return self._record_failure(txn_id, "generation", e)

        try:
            inserted = self._writer.write(
                event=event,
                report=report,
                llm_model_version=self._generator.model_version(),
                prompt_template_version=config.PROMPT_TEMPLATE_VERSION,
                generation_latency_ms=latency_ms,
            )
        except Exception as e:
            return self._record_failure(txn_id, "persistence", e)

        # Successful processing - clear any retry state for this txn.
        self._retry_counts.pop(txn_id, None)

        if inserted:
            self._processed += 1
            logger.info(
                "Report persisted: txn=%s verdict=%s action=%s conf=%.2f latency=%dms",
                txn_id, report.verdict, report.recommended_action,
                report.agent_confidence, latency_ms,
            )
        else:
            self._duplicates += 1

        if (self._processed + self._duplicates) % 50 == 0:
            logger.info(
                "Stats: processed=%d duplicates=%d failed=%d dropped=%d",
                self._processed, self._duplicates, self._failed, self._dropped_poison,
            )
        return True

    def _record_failure(self, txn_id: str, stage: str, exc: Exception) -> bool:
        """
        Increment the retry counter for ``txn_id``. Returns False (skip commit
        / let Kafka redeliver) until the retry budget is exhausted, then
        returns True (drop) so the partition does not stall on poison data.
        """
        attempts = self._retry_counts.get(txn_id, 0) + 1
        self._retry_counts[txn_id] = attempts
        self._failed += 1
        if attempts >= self._max_retries:
            self._dropped_poison += 1
            self._retry_counts.pop(txn_id, None)
            logger.error(
                "DROPPING poison message after %d %s failures: txn=%s err=%s",
                attempts, stage, txn_id, exc, exc_info=True,
            )
            return True  # commit offset to unblock partition
        logger.warning(
            "%s failure %d/%d for txn=%s: %s (will retry)",
            stage, attempts, self._max_retries, txn_id, exc,
        )
        return False  # let Kafka redeliver

    # ────────────────────────────────────────────────────────────
    # Health server (for Docker / Prometheus)
    # ────────────────────────────────────────────────────────────
    def _start_health_server(self) -> None:
        service = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return  # silence default access log

            def do_GET(self):
                if self.path in ("/livez", "/health"):
                    self._respond(200, {"status": "UP"})
                elif self.path == "/readyz":
                    ready = service._consumer.is_connected()
                    self._respond(200 if ready else 503, {"status": "UP" if ready else "DOWN"})
                elif self.path == "/stats":
                    self._respond(
                        200,
                        {
                            "processed": service._processed,
                            "duplicates": service._duplicates,
                            "failed": service._failed,
                            "dropped_poison": service._dropped_poison,
                            "in_flight_retries": len(service._retry_counts),
                            "llm_model": service._generator.model_version(),
                        },
                    )
                else:
                    self._respond(404, {"error": "not found"})

            def _respond(self, status: int, body: Dict[str, Any]):
                payload = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        # SO_REUSEADDR must be set on the class before bind, not on the instance.
        socketserver.TCPServer.allow_reuse_address = True
        try:
            self._health_server = socketserver.TCPServer(("0.0.0.0", config.METRICS_PORT), Handler)
            self._health_thread = threading.Thread(
                target=self._health_server.serve_forever, name="fia-health", daemon=True
            )
            self._health_thread.start()
            logger.info("Health server listening on :%d", config.METRICS_PORT)
        except OSError as e:
            logger.warning("Health server failed to bind on :%d (%s)", config.METRICS_PORT, e)

    def _stop_health_server(self) -> None:
        if self._health_server is not None:
            try:
                self._health_server.shutdown()
                self._health_server.server_close()
            except Exception as e:
                logger.warning("Error stopping health server: %s", e)

    # ────────────────────────────────────────────────────────────
    # Lifecycle
    # ────────────────────────────────────────────────────────────
    def run(self) -> None:
        self._start_health_server()

        def _shutdown(_sig, _frame):
            logger.info("Shutdown signal received")
            self._consumer.stop()

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        # If Kafka was unreachable at startup, retry connection periodically so
        # the service self-heals after a broker restart instead of requiring
        # a container restart.
        import time as _time
        while not self._consumer.is_connected() and not self._consumer._stop:
            logger.warning("Kafka not reachable - retrying in 30s")
            _time.sleep(30)
            self._consumer._try_connect()
            if self._consumer._stop:
                self._stop_health_server()
                self._db.close()
                return

        try:
            self._consumer.consume(self.handle)
        finally:
            self._stop_health_server()
            self._db.close()
            logger.info(
                "FIA shutdown: processed=%d duplicates=%d failed=%d",
                self._processed, self._duplicates, self._failed,
            )


if __name__ == "__main__":
    try:
        FIAService().run()
    except Exception as e:
        logger.error("Fatal: %s", e, exc_info=True)
        sys.exit(1)
