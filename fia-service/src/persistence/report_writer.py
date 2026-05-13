"""
Persistence layer for investigation reports.

Writes go to the `investigationReports` table created by the Knex migration
in src/database/migrations/20240413000007_create_investigation_reports_table.ts.
We use INSERT ... ON CONFLICT DO NOTHING on transactionId so re-delivered Kafka
messages don't crash the consumer (idempotency).
"""

import json
from typing import Any, Dict

from src.llm.report_schema import InvestigationReport
from src.utils.database import DatabaseConnection
from src.utils.logger import get_logger

logger = get_logger("FIA.persistence")


_INSERT_SQL = """
INSERT INTO "investigationReports" (
    "transactionId", "senderId", "receiverId", amount, "transactionType",
    "mlFraudProbability", "mlDecision",
    verdict, "agentConfidence", "recommendedAction",
    narrative, "keyIndicators", "featuresSnapshot",
    "llmModelVersion", "promptTemplateVersion", "generationLatencyMs",
    status
) VALUES (
    :transaction_id, :sender_id, :receiver_id, :amount, :transaction_type,
    :ml_fraud_probability, :ml_decision,
    :verdict, :agent_confidence, :recommended_action,
    :narrative, CAST(:key_indicators AS JSONB), CAST(:features_snapshot AS JSONB),
    :llm_model_version, :prompt_template_version, :generation_latency_ms,
    'GENERATED'
)
ON CONFLICT ("transactionId") DO NOTHING
"""


class ReportWriter:
    def __init__(self, db: DatabaseConnection):
        self._db = db

    def write(
        self,
        event: Dict[str, Any],
        report: InvestigationReport,
        llm_model_version: str,
        prompt_template_version: str,
        generation_latency_ms: int,
    ) -> bool:
        """Persist a report. Returns True if a row was inserted, False on duplicate."""
        params = {
            "transaction_id": event.get("transaction_id"),
            "sender_id": event.get("sender_id"),
            "receiver_id": event.get("receiver_id"),
            "amount": event.get("amount"),
            "transaction_type": event.get("transaction_type"),
            "ml_fraud_probability": event.get("fraud_probability"),
            "ml_decision": event.get("decision"),
            "verdict": report.verdict,
            "agent_confidence": report.agent_confidence,
            "recommended_action": report.recommended_action,
            "narrative": report.narrative,
            "key_indicators": json.dumps(report.key_indicators),
            "features_snapshot": json.dumps(
                {
                    "device_fingerprint": event.get("device_fingerprint"),
                    "timestamp": event.get("timestamp"),
                    "processed_at": event.get("processed_at"),
                }
            ),
            "llm_model_version": llm_model_version,
            "prompt_template_version": prompt_template_version,
            "generation_latency_ms": generation_latency_ms,
        }
        rowcount = self._db.execute_write(_INSERT_SQL, params)
        if rowcount == 0:
            logger.info(
                "Report already exists for transaction_id=%s (idempotent skip)",
                event.get("transaction_id"),
            )
            return False
        return True
