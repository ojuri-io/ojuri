"""
Thin SQLAlchemy reader/writer for the two MLA-owned settings tables:
`mlaSettings` (single-row drift config) and `retrainRuns` (history).

Schema lives in `src/database/migrations/20260515000002_create_settings_tables.ts`;
this module is the read/write surface MLA's admin handlers use. Reads
are direct (no caching) because the call rate is low — the operator
loads the Settings page once in a while, not on every Kafka message.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.engine import Engine


def load_drift_config(engine: Engine) -> Dict[str, Any]:
    """Read the singleton mlaSettings row."""
    with engine.connect() as conn:
        row = conn.execute(
            text(
                'SELECT "driftF1Threshold", "driftPsiThreshold", "driftWindowSize", '
                '"autoRetrainEnabled", "trainingMode", "continuedTreesPerRound", '
                '"updatedBy", "updatedAt" '
                'FROM "mlaSettings" WHERE id = 1'
            )
        ).mappings().first()
    if not row:
        return {
            "driftF1Threshold": 0.92,
            "driftPsiThreshold": 0.25,
            "driftWindowSize": 1000,
            "autoRetrainEnabled": True,
            "trainingMode": "FRESH",
            "continuedTreesPerRound": 50,
            "updatedBy": None,
            "updatedAt": None,
        }
    return {
        "driftF1Threshold": float(row["driftF1Threshold"]),
        "driftPsiThreshold": float(row["driftPsiThreshold"]),
        "driftWindowSize": int(row["driftWindowSize"]),
        "autoRetrainEnabled": bool(row["autoRetrainEnabled"]),
        "trainingMode": row["trainingMode"],
        "continuedTreesPerRound": int(row["continuedTreesPerRound"]),
        "updatedBy": row["updatedBy"],
        "updatedAt": row["updatedAt"].isoformat() if row["updatedAt"] else None,
    }


def save_drift_config(
    engine: Engine,
    f1: float,
    psi: float,
    window: int,
    auto_retrain: bool,
    training_mode: str,
    continued_trees: int,
    updated_by: Optional[str],
) -> Dict[str, Any]:
    """Patch the singleton row in place. Returns the post-update view."""
    with engine.begin() as conn:
        conn.execute(
            text(
                'UPDATE "mlaSettings" SET '
                '  "driftF1Threshold" = :f1, '
                '  "driftPsiThreshold" = :psi, '
                '  "driftWindowSize" = :window, '
                '  "autoRetrainEnabled" = :auto, '
                '  "trainingMode" = :mode, '
                '  "continuedTreesPerRound" = :trees, '
                '  "updatedBy" = :who, '
                '  "updatedAt" = NOW() '
                'WHERE id = 1'
            ),
            {
                "f1": f1, "psi": psi, "window": window, "auto": auto_retrain,
                "mode": training_mode, "trees": continued_trees, "who": updated_by,
            },
        )
    return load_drift_config(engine)


def insert_retrain_run(
    engine: Engine,
    trigger: str,
    triggered_by: Optional[str],
    status: str = "running",
) -> str:
    """
    Insert a new retrain row, return its id. `status` defaults to
    "running"; the worker updates to succeeded/failed/rejected when
    the pipeline returns.
    """
    with engine.begin() as conn:
        row = conn.execute(
            text(
                'INSERT INTO "retrainRuns" (trigger, "triggeredBy", status) '
                "VALUES (:trigger, :who, :status) RETURNING id"
            ),
            {"trigger": trigger, "who": triggered_by, "status": status},
        ).mappings().first()
    return str(row["id"])


def complete_retrain_run(
    engine: Engine,
    run_id: str,
    status: str,
    metrics: Optional[Dict[str, Any]] = None,
    model_version: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                'UPDATE "retrainRuns" SET '
                '  status = :status, '
                '  metrics = CAST(:metrics AS jsonb), '
                '  "modelVersion" = :v, '
                '  "failureReason" = :reason, '
                '  "completedAt" = NOW() '
                "WHERE id = :id"
            ),
            {
                "id": run_id,
                "status": status,
                "metrics": json.dumps(metrics) if metrics else None,
                "v": model_version,
                "reason": failure_reason,
            },
        )


def list_retrain_runs(engine: Engine, limit: int = 20) -> List[Dict[str, Any]]:
    with engine.connect() as conn:
        rows = (
            conn.execute(
                text(
                    'SELECT id, trigger, "triggeredBy", status, metrics, "modelVersion", '
                    '"failureReason", "startedAt", "completedAt" '
                    'FROM "retrainRuns" ORDER BY "startedAt" DESC LIMIT :limit'
                ),
                {"limit": limit},
            )
            .mappings()
            .all()
        )
    out = []
    for r in rows:
        out.append({
            "id": str(r["id"]),
            "trigger": r["trigger"],
            "triggeredBy": r["triggeredBy"],
            "status": r["status"],
            "metrics": r["metrics"],
            "modelVersion": r["modelVersion"],
            "failureReason": r["failureReason"],
            "startedAt": r["startedAt"].isoformat() if r["startedAt"] else None,
            "completedAt": r["completedAt"].isoformat() if r["completedAt"] else None,
        })
    return out


def has_in_flight_retrain(engine: Engine) -> bool:
    """In-flight = `running` row in the last 30 minutes (anything older
    we treat as a stale process — the new request gets to fire)."""
    with engine.connect() as conn:
        row = (
            conn.execute(
                text(
                    'SELECT id FROM "retrainRuns" WHERE status = \'running\' '
                    "AND \"startedAt\" > NOW() - INTERVAL '30 minutes' LIMIT 1"
                )
            )
            .mappings()
            .first()
        )
    return row is not None
