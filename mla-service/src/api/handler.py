"""
Tiny built-in HTTP handler for MLA.

Exposes the same shape as FIA so the frontend system-health dashboard
can poll every service through one common pattern. Endpoints:

- GET /livez   — process is alive
- GET /readyz  — drift detector + Kafka consumer (when relevant) are up
- GET /stats   — counters that answer "is automated retraining running?"

The handler is deliberately based on http.server / socketserver to
avoid adding Flask / FastAPI to MLA's already-heavy dependency set
(scikit-learn, xgboost, imbalanced-learn, onnxmltools).
"""

import json
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable


class MLAHttpHandler(BaseHTTPRequestHandler):
    """Service instance is injected via class attribute (see make_handler)."""

    service: Any = None  # type: ignore

    def log_message(self, *_args):
        # Suppress default access log — main.py already emits lifecycle events.
        return

    def do_GET(self):  # noqa: N802
        if self.path in ("/livez", "/health"):
            return self._respond(200, {"status": "UP"})

        if self.path == "/readyz":
            ready = self.service.is_ready()
            return self._respond(200 if ready else 503, {"status": "UP" if ready else "DOWN"})

        if self.path == "/stats":
            return self._respond(200, self.service.stats())

        return self._respond(404, {"error": "not found"})

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
