"""
Tiny built-in HTTP handler for the FIA service.

In addition to the original health endpoints, it now exposes:

- POST /v1/reports                       — generate a report for any transaction
- GET  /v1/reports/{report_id}           — read the report + conversation
- GET  /v1/reports                       — list recent reports
- POST /v1/reports/{report_id}/messages  — conversational follow-up

The handler is intentionally based on http.server / socketserver to
avoid pulling in Flask / FastAPI — FIA's container image is already
heavy because of torch + transformers, and these endpoints are not
on a hot path.
"""

import json
import re
import uuid
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Dict, List, Optional, Tuple


_REPORT_BY_ID = re.compile(r"^/v1/reports/([0-9a-fA-F-]{36})$")
_REPORT_MESSAGES = re.compile(r"^/v1/reports/([0-9a-fA-F-]{36})/messages$")


class FIAHttpHandler(BaseHTTPRequestHandler):
    """Routes injected via class attributes set by the factory below."""

    service: Any = None  # type: ignore

    def log_message(self, *_args):
        # Suppress the default access log; main.py already logs lifecycle.
        return

    # ─────────────────────────────────────────────────────────
    # Dispatch
    # ─────────────────────────────────────────────────────────
    def do_GET(self):  # noqa: N802
        if self.path in ("/livez", "/health"):
            return self._respond(200, {"status": "UP"})

        if self.path == "/readyz":
            ready = self.service.is_ready()
            return self._respond(200 if ready else 503, {"status": "UP" if ready else "DOWN"})

        if self.path == "/stats":
            return self._respond(200, self.service.stats())

        if self.path.startswith("/v1/reports"):
            return self._do_get_report()

        return self._respond(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path == "/v1/reports":
            return self._do_create_report()

        match = _REPORT_MESSAGES.match(self.path)
        if match:
            return self._do_create_message(match.group(1))

        return self._respond(404, {"error": "not found"})

    # ─────────────────────────────────────────────────────────
    # GET /v1/reports[/:id]
    # ─────────────────────────────────────────────────────────
    def _do_get_report(self):
        match = _REPORT_BY_ID.match(self.path)
        if match:
            report = self.service.get_report(match.group(1))
            if not report:
                return self._respond(404, {"error": "report not found"})
            return self._respond(200, report)

        if self.path == "/v1/reports":
            limit, offset, status = self._list_params()
            return self._respond(
                200,
                {"reports": self.service.list_reports(status=status, limit=limit, offset=offset)},
            )

        return self._respond(404, {"error": "not found"})

    def _list_params(self) -> Tuple[int, int, Optional[str]]:
        # http.server doesn't parse query strings — do it manually.
        from urllib.parse import urlparse, parse_qs

        q = parse_qs(urlparse(self.path).query)
        limit = int((q.get("limit", ["50"])[0]))
        offset = int((q.get("offset", ["0"])[0]))
        status = q.get("status", [None])[0]
        return min(limit, 200), max(offset, 0), status

    # ─────────────────────────────────────────────────────────
    # POST /v1/reports
    # ─────────────────────────────────────────────────────────
    def _do_create_report(self):
        body = self._read_json_body()
        if body is None:
            return self._respond(400, {"error": "invalid JSON body"})

        # Accept camelCase `transactionId` from the frontend alongside
        # the snake_case `transaction_id` Kafka payloads use.
        if "transactionId" in body and "transaction_id" not in body:
            body["transaction_id"] = body["transactionId"]

        # The only field the caller MUST supply is `transaction_id`.
        # Everything else is hydrated from `decisionAuditLog` so the
        # operator's "Investigate" click works with just the row id.
        txn_id = body.get("transaction_id")
        if not txn_id:
            return self._respond(400, {"error": "missing required field: transaction_id"})

        # Optional-field defaults — only used if neither the body nor
        # the audit hydrate fill them in. Lets the endpoint serve
        # accepted-but-suspicious transactions, not just blocked ones.
        body.setdefault("decision", "DECLINE")
        body.setdefault("fraud_probability", body.get("fraud_probability") or 0.0)
        body.setdefault("receiver_id", body.get("receiver_id"))
        body.setdefault("timestamp", body.get("timestamp"))

        report, status_code = self.service.create_report(body)
        return self._respond(status_code, report)

    # ─────────────────────────────────────────────────────────
    # POST /v1/reports/:id/messages
    # ─────────────────────────────────────────────────────────
    def _do_create_message(self, report_id: str):
        body = self._read_json_body()
        if body is None or not body.get("content"):
            return self._respond(400, {"error": "content is required"})

        try:
            uuid.UUID(report_id)
        except ValueError:
            return self._respond(400, {"error": "invalid report id"})

        try:
            response, status_code = self.service.add_message(report_id, body["content"])
        except KeyError:
            return self._respond(404, {"error": "report not found"})

        return self._respond(status_code, response)

    # ─────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────
    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _respond(self, status: int, body: Dict[str, Any] | List[Any]):
        payload = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def make_handler(service: Any) -> Callable[..., FIAHttpHandler]:
    """Bind the service instance to the handler class."""
    # http.server requires a class, not a closure — we subclass per
    # binding so multiple FIA instances (e.g. in tests) don't share
    # state through the class attribute.
    return type(
        "FIAHttpHandlerBound",
        (FIAHttpHandler,),
        {"service": service},
    )
