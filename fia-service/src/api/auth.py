"""
Minimal HS256 JWT verifier for the FIA HTTP API.

FIA shares the `AUTH_JWT_SECRET` with RDA so the same operator JWT
issued by `POST /v1/auth/login` works for both surfaces. We do the
verification in stdlib (hmac + base64 + json) to avoid adding PyJWT to
an already-heavy container image.

Supported: HS256 only. Reject anything else explicitly to prevent
algorithm-confusion attacks. Token must carry `userId`, `tenantId`,
`username`, `permissions[]` exactly like RDA mints.
"""

from __future__ import annotations

import base64
import hmac
import hashlib
import json
import os
from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass(frozen=True)
class AuthSubject:
    user_id: str
    tenant_id: str
    username: str
    permissions: list[str]

    def has_permission(self, required: Iterable[str]) -> bool:
        required_list = list(required)
        if not required_list:
            return True
        if "*" in self.permissions:
            return True
        return any(p in self.permissions for p in required_list)


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def verify_token(token: str) -> Optional[AuthSubject]:
    """Return the decoded AuthSubject, or None on any verification failure.

    We deliberately return None (not raise) for the typical 401 path —
    raises are reserved for genuinely unexpected conditions.
    """
    secret = os.environ.get("AUTH_JWT_SECRET", "")
    if not secret:
        return None

    parts = token.split(".")
    if len(parts) != 3:
        return None

    header_b64, payload_b64, signature_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64).decode("utf-8"))
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        signature = _b64url_decode(signature_b64)
    except (ValueError, UnicodeDecodeError):
        return None

    # Algorithm pinning: HS256 only. Reject `alg: none`, `RS*`, `HS384/512`.
    if header.get("alg") != "HS256":
        return None
    if header.get("typ") not in (None, "JWT"):
        return None

    expected = hmac.new(
        secret.encode("utf-8"),
        f"{header_b64}.{payload_b64}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(expected, signature):
        return None

    # Standard claims (best-effort): exp / nbf / iat in seconds since epoch.
    import time as _time

    now = int(_time.time())
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and now >= int(exp):
        return None
    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and now < int(nbf):
        return None

    # Optional pinning (defence-in-depth, off by default).
    expected_iss = os.environ.get("AUTH_JWT_ISSUER")
    if expected_iss and payload.get("iss") not in (None, expected_iss):
        return None
    expected_aud = os.environ.get("AUTH_JWT_AUDIENCE")
    if expected_aud and payload.get("aud") not in (None, expected_aud):
        return None

    user_id = payload.get("userId")
    tenant_id = payload.get("tenantId", "default")
    username = payload.get("username", "")
    permissions = payload.get("permissions") or []
    if not isinstance(user_id, str) or not isinstance(permissions, list):
        return None

    return AuthSubject(
        user_id=user_id,
        tenant_id=str(tenant_id),
        username=str(username),
        permissions=[str(p) for p in permissions if isinstance(p, str)],
    )


def extract_bearer(header_value: Optional[str]) -> Optional[str]:
    if not header_value:
        return None
    parts = header_value.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None
