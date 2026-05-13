"""
Fraud Investigation Agent (FIA) entry point.

Pipeline:
1. Consume `transactions.blocked` from Kafka (published by RDA on DECLINE).
2. For each event, generate a structured investigation report via Phi-3.
3. Persist the report into PostgreSQL `investigationReports`.
4. Commit Kafka offset only after a successful (or idempotently-skipped) write.

Also exposes an HTTP API (port `METRICS_PORT`, default 9094) for
on-demand report generation and conversational follow-ups — see
`src/api/handler.py`.
"""

import json
import signal
import socketserver
import sys
import threading
from typing import Any, Dict, List, Optional, Tuple

from src.api.handler import make_handler
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

        self._http_server: Optional[socketserver.TCPServer] = None
        self._http_thread: Optional[threading.Thread] = None

        logger.info("FIA components initialized (llm=%s)", self._generator.model_version())

    # ────────────────────────────────────────────────────────────
    # Message handler (Kafka)
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
            return True

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
            return True
        logger.warning(
            "%s failure %d/%d for txn=%s: %s (will retry)",
            stage, attempts, self._max_retries, txn_id, exc,
        )
        return False

    # ────────────────────────────────────────────────────────────
    # API surface exposed to the HTTP handler
    # ────────────────────────────────────────────────────────────
    def is_ready(self) -> bool:
        return self._consumer.is_connected()

    def stats(self) -> Dict[str, Any]:
        return {
            "processed": self._processed,
            "duplicates": self._duplicates,
            "failed": self._failed,
            "dropped_poison": self._dropped_poison,
            "in_flight_retries": len(self._retry_counts),
            "llm_model": self._generator.model_version(),
        }

    def create_report(self, event: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
        """
        On-demand report generation for any transaction.

        Returns (report_dict, http_status_code). Idempotency is by
        `transactionId` — a re-request for the same transaction returns
        the existing report row with status 200.
        """
        existing = self._writer.get_by_transaction_id(event["transaction_id"])
        if existing:
            return self._enrich_with_conversation(existing), 200

        try:
            report, latency_ms = self._generator.generate(event)
        except Exception as e:
            logger.error("On-demand generation failed: %s", e, exc_info=True)
            return {"error": "generation failed", "detail": str(e)}, 500

        try:
            self._writer.write(
                event=event,
                report=report,
                llm_model_version=self._generator.model_version(),
                prompt_template_version=config.PROMPT_TEMPLATE_VERSION,
                generation_latency_ms=latency_ms,
            )
        except Exception as e:
            logger.error("On-demand persistence failed: %s", e, exc_info=True)
            return {"error": "persistence failed", "detail": str(e)}, 500

        row = self._writer.get_by_transaction_id(event["transaction_id"]) or {}
        return self._enrich_with_conversation(row), 201

    def add_message(self, report_id: str, user_message: str) -> Tuple[Dict[str, Any], int]:
        report = self._writer.get_by_id(report_id)
        if not report:
            raise KeyError(report_id)

        history = self._writer.get_conversation(report_id)
        history_payload = [{"role": t["role"], "content": t["content"]} for t in history]

        user_idx = self._writer.next_turn_index(report_id)
        self._writer.add_turn(
            report_id=report_id,
            transaction_id=report["transactionId"],
            turn_index=user_idx,
            role="user",
            content=user_message,
            llm_model_version=None,
            latency_ms=None,
        )

        try:
            answer, latency_ms = self._generator.chat(report, history_payload, user_message)
        except Exception as e:
            logger.error("Chat generation failed: %s", e, exc_info=True)
            return {"error": "chat generation failed", "detail": str(e)}, 500

        self._writer.add_turn(
            report_id=report_id,
            transaction_id=report["transactionId"],
            turn_index=user_idx + 1,
            role="assistant",
            content=answer,
            llm_model_version=self._generator.model_version(),
            latency_ms=latency_ms,
        )

        return {
            "report_id": report_id,
            "user_turn": {"role": "user", "content": user_message},
            "assistant_turn": {
                "role": "assistant",
                "content": answer,
                "llm_model_version": self._generator.model_version(),
                "latency_ms": latency_ms,
            },
        }, 201

    def get_report(self, report_id: str) -> Optional[Dict[str, Any]]:
        report = self._writer.get_by_id(report_id)
        if not report:
            return None
        return self._enrich_with_conversation(report)

    def list_reports(self, status: Optional[str], limit: int, offset: int) -> List[Dict[str, Any]]:
        return self._writer.list_reports(status=status, limit=limit, offset=offset)

    def _enrich_with_conversation(self, report: Dict[str, Any]) -> Dict[str, Any]:
        report_id = report.get("id")
        if not report_id:
            return report
        report["conversation"] = self._writer.get_conversation(str(report_id))
        return report

    # ────────────────────────────────────────────────────────────
    # HTTP server (health + report API)
    # ────────────────────────────────────────────────────────────
    def _start_http_server(self) -> None:
        socketserver.TCPServer.allow_reuse_address = True
        try:
            self._http_server = socketserver.TCPServer(
                ("0.0.0.0", config.METRICS_PORT), make_handler(self)
            )
            self._http_thread = threading.Thread(
                target=self._http_server.serve_forever, name="fia-http", daemon=True
            )
            self._http_thread.start()
            logger.info("HTTP server listening on :%d", config.METRICS_PORT)
        except OSError as e:
            logger.warning("HTTP server failed to bind on :%d (%s)", config.METRICS_PORT, e)

    def _stop_http_server(self) -> None:
        if self._http_server is not None:
            try:
                self._http_server.shutdown()
                self._http_server.server_close()
            except Exception as e:
                logger.warning("Error stopping HTTP server: %s", e)

    # ────────────────────────────────────────────────────────────
    # Lifecycle
    # ────────────────────────────────────────────────────────────
    def run(self) -> None:
        self._start_http_server()

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
                self._stop_http_server()
                self._db.close()
                return

        try:
            self._consumer.consume(self.handle)
        finally:
            self._stop_http_server()
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
