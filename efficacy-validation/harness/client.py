"""HTTP client for the Ojuri stack. Stdlib only.

Talks to the unmodified `docker compose up` stack through NGINX on :80.
Send rate must stay well under the NGINX 100r/s per-IP limit on /v1/predict;
the runner throttles to DEFAULT_RPS.

Admin auth follows the normal operator flow: the seeded admin password is
printed once by the db-migrate container; we scrape it from
`docker compose logs db-migrate`, log in, and rotate to HARNESS_PASSWORD
(required — admin routes are gated until the forced first rotation).
"""

import json
import re
import subprocess
import time
import urllib.error
import urllib.request

BASE_URL = "http://localhost:80"
HARNESS_PASSWORD = "EfficacyV1-Harness-2026"
DEFAULT_RPS = 20.0
RETRYABLE = {429, 503}


class HarnessError(Exception):
    pass


def _request(method: str, path: str, body=None, token=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            payload = json.load(e)
        except Exception:
            payload = {"raw": e.read().decode(errors="replace")}
        return e.code, payload
    except Exception as e:
        return -1, {"error": str(e)}


def predict(body: dict) -> tuple:
    attempts = 0
    while True:
        status, payload = _request("POST", "/v1/predict", body)
        if status == 200:
            return status, payload
        if status in RETRYABLE or status == -1:
            attempts += 1
            if attempts > 5:
                raise HarnessError(f"predict failed after retries: {status} {payload}")
            time.sleep(min(2 ** attempts * 0.5, 8))
            continue
        raise HarnessError(f"predict returned non-200 {status}: {payload} "
                           f"(txn={body.get('transaction_id')})")


def _scrape_seed_password() -> str:
    out = subprocess.run(["docker", "compose", "logs", "db-migrate"],
                         capture_output=True, text=True, timeout=30).stdout
    m = re.search(r"password:\s+(\S+)", out)
    if not m:
        raise HarnessError("could not find seeded admin password in db-migrate logs")
    return m.group(1)


def admin_token() -> str:
    status, payload = _request("POST", "/v1/auth/login",
                               {"username": "admin", "password": HARNESS_PASSWORD})
    if status == 200:
        return payload["data"]["token"]
    seed_pw = _scrape_seed_password()
    status, payload = _request("POST", "/v1/auth/login",
                               {"username": "admin", "password": seed_pw})
    if status != 200:
        raise HarnessError(f"admin login failed with both harness and seeded password: {payload}")
    token = payload["data"]["token"]
    status, payload = _request("POST", "/v1/auth/change-password",
                               {"currentPassword": seed_pw, "newPassword": HARNESS_PASSWORD},
                               token=token)
    if status != 200:
        raise HarnessError(f"password rotation failed: {payload}")
    return payload["data"]["token"]


def fetch_audit_rows(token: str, search: str, since_iso: str) -> list:
    rows, offset = [], 0
    while True:
        status, payload = _request(
            "GET", f"/v1/admin/audit?search={search}&from={since_iso}&limit=500&offset={offset}",
            token=token, timeout=30)
        if status != 200:
            raise HarnessError(f"audit fetch failed: {status} {payload}")
        data = payload.get("data", payload)
        batch = data.get("rows", [])
        rows.extend(batch)
        offset += len(batch)
        if len(batch) < 500 or offset >= data.get("total", 0):
            return rows


def fetch_decision_snapshot(token: str, txn_id: str) -> dict:
    status, payload = _request("GET", f"/v1/decisions/{txn_id}", token=token, timeout=15)
    if status != 200:
        return {}
    row = payload.get("data", payload) or {}
    return row.get("featuresSnapshot") or {}


def paa_stats() -> dict:
    try:
        with urllib.request.urlopen("http://localhost:9091/stats", timeout=5) as r:
            return json.load(r)
    except Exception as e:
        return {"error": str(e)}


def wait_for_paa(expected_processed: int, timeout_s: float = 45.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        stats = paa_stats()
        if stats.get("processedCount", -1) >= expected_processed:
            return True
        time.sleep(1.0)
    return False
