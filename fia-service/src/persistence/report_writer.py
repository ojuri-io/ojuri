"""
Persistence layer for investigation reports.

Writes go to the `investigationReports` table created by the Knex migration
in src/database/migrations/20240413000007_create_investigation_reports_table.ts.
We use INSERT ... ON CONFLICT DO NOTHING on transactionId so re-delivered Kafka
messages don't crash the consumer (idempotency).

This module also persists conversational follow-ups in
`investigationConversations` so the FIA UI / API can render a chat history
alongside the canonical report row.
"""

import json
from typing import Any, Dict, List, Optional

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
RETURNING id
"""


_SELECT_BY_ID_SQL = """
SELECT id, "transactionId", "senderId", "receiverId", amount, "transactionType",
       "mlFraudProbability", "mlDecision", verdict, "agentConfidence",
       "recommendedAction", narrative, "keyIndicators", "featuresSnapshot",
       "llmModelVersion", "promptTemplateVersion", "generationLatencyMs",
       status, "reviewedBy", "reviewedAt", "createdAt"
FROM "investigationReports"
WHERE id = :id
"""


_SELECT_BY_TXN_SQL = """
SELECT id, "transactionId", "senderId", "receiverId", amount, "transactionType",
       "mlFraudProbability", "mlDecision", verdict, "agentConfidence",
       "recommendedAction", narrative, "keyIndicators", "featuresSnapshot",
       "llmModelVersion", "promptTemplateVersion", "generationLatencyMs",
       status, "createdAt"
FROM "investigationReports"
WHERE "transactionId" = :transaction_id
ORDER BY "createdAt" DESC
LIMIT 1
"""


_SELECT_AUDIT_BY_TXN_SQL = """
SELECT "transactionId", "senderId", "receiverId", amount, "transactionType",
       "championScore", "finalDecision", "decisionSource", "ruleName",
       "createdAt"
FROM "decisionAuditLog"
WHERE "transactionId" = :transaction_id
ORDER BY "createdAt" DESC
LIMIT 1
"""


_LIST_REPORTS_SQL = """
SELECT id, "transactionId", "senderId", amount, "transactionType",
       verdict, "recommendedAction", "agentConfidence", status, "createdAt"
FROM "investigationReports"
WHERE (:status IS NULL OR status = :status)
ORDER BY "createdAt" DESC
LIMIT :limit OFFSET :offset
"""


_INSERT_CONVERSATION_TURN_SQL = """
INSERT INTO "investigationConversations" (
    "reportId", "transactionId", "turnIndex", role, content,
    "llmModelVersion", "latencyMs"
) VALUES (
    :report_id, :transaction_id, :turn_index, :role, :content,
    :llm_model_version, :latency_ms
)
ON CONFLICT ("reportId", "turnIndex") DO NOTHING
RETURNING id
"""


_LIST_CONVERSATION_SQL = """
SELECT id, "turnIndex" as turn_index, role, content, "llmModelVersion",
       "latencyMs" as latency_ms, "createdAt" as created_at
FROM "investigationConversations"
WHERE "reportId" = :report_id
ORDER BY "turnIndex" ASC
"""


_NEXT_TURN_INDEX_SQL = """
SELECT COALESCE(MAX("turnIndex"), -1) + 1 AS next_index
FROM "investigationConversations"
WHERE "reportId" = :report_id
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
        rows = self._db.execute_write_returning(_INSERT_SQL, params)
        if not rows:
            logger.info(
                "Report already exists for transaction_id=%s (idempotent skip)",
                event.get("transaction_id"),
            )
            return False
        return True

    def get_by_id(self, report_id: str) -> Optional[Dict[str, Any]]:
        rows = self._db.fetch_all(_SELECT_BY_ID_SQL, {"id": report_id})
        if not rows:
            return None
        return self._row_to_dict(rows[0])

    def find_audit_by_transaction_id(self, transaction_id: str) -> Optional[Dict[str, Any]]:
        """
        Hydrate the missing fields of an on-demand `POST /v1/reports`
        request from `decisionAuditLog`. Returns the canonical event
        shape (snake_case) that FIA's generator expects, or `None`
        when no audit row exists yet (e.g. a transaction the platform
        has not yet seen).
        """
        rows = self._db.fetch_all(_SELECT_AUDIT_BY_TXN_SQL, {"transaction_id": transaction_id})
        if not rows:
            return None
        r = self._row_to_dict(rows[0])
        return {
            "transaction_id": r.get("transactionId"),
            "sender_id": r.get("senderId"),
            "receiver_id": r.get("receiverId"),
            "amount": float(r.get("amount") or 0),
            "transaction_type": r.get("transactionType"),
            "fraud_probability": float(r.get("championScore") or 0),
            "decision": r.get("finalDecision") or "DECLINE",
            "decision_source": r.get("decisionSource") or "ML",
            "rule_name": r.get("ruleName"),
        }

    def get_by_transaction_id(self, transaction_id: str) -> Optional[Dict[str, Any]]:
        rows = self._db.fetch_all(_SELECT_BY_TXN_SQL, {"transaction_id": transaction_id})
        if not rows:
            return None
        return self._row_to_dict(rows[0])

    def list_reports(
        self, status: Optional[str] = None, limit: int = 50, offset: int = 0
    ) -> List[Dict[str, Any]]:
        rows = self._db.fetch_all(
            _LIST_REPORTS_SQL, {"status": status, "limit": limit, "offset": offset}
        )
        return [self._row_to_dict(r) for r in rows]

    def next_turn_index(self, report_id: str) -> int:
        rows = self._db.fetch_all(_NEXT_TURN_INDEX_SQL, {"report_id": report_id})
        if not rows:
            return 0
        return int(rows[0][0] if isinstance(rows[0], tuple) else rows[0].next_index)

    def add_turn(
        self,
        report_id: str,
        transaction_id: str,
        turn_index: int,
        role: str,
        content: str,
        llm_model_version: Optional[str],
        latency_ms: Optional[int],
    ) -> bool:
        rows = self._db.execute_write_returning(
            _INSERT_CONVERSATION_TURN_SQL,
            {
                "report_id": report_id,
                "transaction_id": transaction_id,
                "turn_index": turn_index,
                "role": role,
                "content": content,
                "llm_model_version": llm_model_version,
                "latency_ms": latency_ms,
            },
        )
        return bool(rows)

    def get_conversation(self, report_id: str) -> List[Dict[str, Any]]:
        rows = self._db.fetch_all(_LIST_CONVERSATION_SQL, {"report_id": report_id})
        return [self._row_to_dict(r) for r in rows]

    @staticmethod
    def _row_to_dict(row: Any) -> Dict[str, Any]:
        # SQLAlchemy Row objects in 2.x support `._mapping`; tuples are
        # also accepted (returned by some tests). Fall back to vars()
        # for completeness.
        if hasattr(row, "_mapping"):
            return {k: v for k, v in row._mapping.items()}
        if hasattr(row, "_asdict"):
            return row._asdict()
        try:
            return dict(row)
        except Exception:
            return {"value": str(row)}
