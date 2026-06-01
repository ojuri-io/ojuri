"""
Tiny built-in HTTP handler for MLA.

Public endpoints (no auth):
- GET /livez   — process is alive
- GET /readyz  — drift detector + Kafka consumer (when relevant) are up
- GET /stats   — counters that answer "is automated retraining running?"

Admin endpoints (JWT, same secret as RDA — `mla:configure` permission):
- GET    /v1/admin/drift-config         — current thresholds + window + last drift check
- PUT    /v1/admin/drift-config         — update thresholds; server-side clamped
- POST   /v1/admin/retrain              — fire a manual retrain (idempotent against in-flight)
- GET    /v1/admin/retrain-runs         — recent retrain history (drift + manual + initial)

The handler is intentionally based on http.server / ThreadingHTTPServer
to avoid adding Flask / FastAPI to MLA's already-heavy dependency set
(scikit-learn, xgboost, imbalanced-learn, onnxmltools, pyjwt).
"""

import json
import logging
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Dict, Optional

from src.api.auth import AuthError, AuthSubject, require_permission, verify_bearer
from src.api.settings_repo import (
    has_in_flight_retrain,
    insert_retrain_run,
    list_retrain_runs,
    load_drift_config,
    save_drift_config,
)


log = logging.getLogger(__name__)


# Server-side clamps for drift config. Out-of-range values would either
# kill the retrain loop (F1=0.99 thrashes; PSI=0.001 fires on every
# batch) or render it useless (F1=0.0 never fires). The UI explains
# these tradeoffs but the server enforces them regardless of source.
DRIFT_BOUNDS = {
    "driftF1Threshold": (0.5, 0.99),
    "driftPsiThreshold": (0.05, 0.5),
    "driftWindowSize": (100, 100_000),
    "continuedTreesPerRound": (10, 500),
}

VALID_TRAINING_MODES = ("FRESH", "CONTINUED")


class MLAHttpHandler(BaseHTTPRequestHandler):
    """Service instance is injected via class attribute (see make_handler)."""

    service: Any = None  # type: ignore

    def log_message(self, *_args):
        # Suppress default access log — main.py already emits lifecycle events.
        return

    # ─── public ────────────────────────────────────────────────

    def do_GET(self):  # noqa: N802
        if self.path in ("/livez", "/health"):
            return self._respond(200, {"status": "UP"})

        if self.path == "/readyz":
            ready = self.service.is_ready()
            return self._respond(200 if ready else 503, {"status": "UP" if ready else "DOWN"})

        if self.path == "/stats":
            return self._respond(200, self.service.stats())

        if self.path == "/v1/admin/drift-config":
            return self._admin_get_drift_config()

        if self.path == "/v1/admin/retrain-runs":
            return self._admin_list_retrain_runs()

        return self._respond(404, {"error": "not found"})

    def do_PUT(self):  # noqa: N802
        if self.path == "/v1/admin/drift-config":
            return self._admin_put_drift_config()
        return self._respond(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path == "/v1/admin/retrain":
            return self._admin_trigger_retrain()
        return self._respond(404, {"error": "not found"})

    # ─── admin handlers ────────────────────────────────────────

    def _admin_get_drift_config(self):
        try:
            subj = self._require_perm("mla:configure", "settings:read")
        except AuthError as err:
            return self._respond(err.status, {"error": err.message})
        try:
            cfg = load_drift_config(self.service.db_engine)
            stats = self.service.stats()
            cfg["last_drift_check_at"] = stats.get("last_drift_check_at")
            cfg["last_drift_detected_at"] = stats.get("last_drift_detected_at")
            cfg["last_retraining_completed_at"] = stats.get("last_retraining_completed_at")
            cfg["effective"] = self.service.effective_drift_config()
            return self._respond(200, {"status": True, "data": cfg})
        except Exception as err:
            log.exception("drift-config GET failed")
            return self._respond(500, {"error": str(err)})

    def _admin_put_drift_config(self):
        try:
            subj = self._require_perm("mla:configure")
            body = self._read_json_body()
            current = load_drift_config(self.service.db_engine)
            f1 = float(body.get("driftF1Threshold", current["driftF1Threshold"]))
            psi = float(body.get("driftPsiThreshold", current["driftPsiThreshold"]))
            window = int(body.get("driftWindowSize", current["driftWindowSize"]))
            auto = bool(body.get("autoRetrainEnabled", current["autoRetrainEnabled"]))
            mode = str(body.get("trainingMode", current["trainingMode"])).upper()
            trees = int(body.get("continuedTreesPerRound", current["continuedTreesPerRound"]))
        except AuthError as err:
            return self._respond(err.status, {"error": err.message})
        except (TypeError, ValueError) as err:
            return self._respond(400, {"error": f"invalid payload: {err}"})

        for k, v in (
            ("driftF1Threshold", f1),
            ("driftPsiThreshold", psi),
            ("driftWindowSize", window),
            ("continuedTreesPerRound", trees),
        ):
            lo, hi = DRIFT_BOUNDS[k]
            if v < lo or v > hi:
                return self._respond(422, {"error": f"{k} must be between {lo} and {hi}"})

        if mode not in VALID_TRAINING_MODES:
            return self._respond(
                422,
                {"error": f"trainingMode must be one of {list(VALID_TRAINING_MODES)}"},
            )

        try:
            updated = save_drift_config(
                self.service.db_engine, f1, psi, window, auto, mode, trees, subj.username,
            )
            self.service.apply_drift_config(updated)
            return self._respond(200, {"status": True, "data": updated})
        except Exception as err:
            log.exception("drift-config PUT failed")
            return self._respond(500, {"error": str(err)})

    def _admin_trigger_retrain(self):
        try:
            subj = self._require_perm("mla:configure")
        except AuthError as err:
            return self._respond(err.status, {"error": err.message})

        try:
            if has_in_flight_retrain(self.service.db_engine):
                return self._respond(
                    409,
                    {"error": "A retrain is already in flight. Wait for it to complete or check the runs list."},
                )

            run_id = insert_retrain_run(
                self.service.db_engine,
                trigger="manual",
                triggered_by=subj.username,
                status="running",
            )
            # Fire-and-forget — the run completes async; the UI polls
            # /v1/admin/retrain-runs to see status. We must NOT block
            # the HTTP response on the full training pipeline (~30s+).
            self.service.trigger_manual_retrain(run_id=run_id, triggered_by=subj.username)
            return self._respond(202, {"status": True, "data": {"runId": run_id, "status": "running"}})
        except Exception as err:
            log.exception("manual retrain failed to start")
            return self._respond(500, {"error": str(err)})

    def _admin_list_retrain_runs(self):
        try:
            self._require_perm("mla:configure", "settings:read")
        except AuthError as err:
            return self._respond(err.status, {"error": err.message})
        try:
            runs = list_retrain_runs(self.service.db_engine, limit=20)
            return self._respond(200, {"status": True, "data": runs})
        except Exception as err:
            log.exception("retrain-runs GET failed")
            return self._respond(500, {"error": str(err)})

    # ─── helpers ───────────────────────────────────────────────

    def _require_perm(self, *anyof: str) -> AuthSubject:
        subj = verify_bearer(self.headers.get("Authorization"))
        require_permission(subj, *anyof)
        return subj

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as err:
            raise ValueError(f"body is not valid JSON: {err}")
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def _respond(self, status: int, body: Any):
        payload = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def make_handler(service: Any) -> Callable[..., MLAHttpHandler]:
    """Bind the MLAService instance to a fresh handler subclass."""
    return type(
        "MLAHttpHandlerBound",
        (MLAHttpHandler,),
        {"service": service},
    )
