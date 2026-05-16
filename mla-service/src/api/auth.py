"""
JWT verification for MLA's admin endpoints.

Mirrors the verify path in `src/shared/authz/auth.service.ts` so the
same token RDA issues authenticates against MLA. Both services share
the `AUTH_JWT_SECRET` env var; MLA never issues tokens of its own —
only verifies what RDA hands the user.

Permission gate: the JWT payload's `permissions` array must contain
either `mla:configure` or the wildcard `*` (granted to SUPER_ADMIN).
Read-only endpoints accept `settings:read` too so a fraud analyst with
read access can see drift state without being able to retrain.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable, Optional

import jwt  # PyJWT


WILDCARD = "*"


@dataclass(frozen=True)
class AuthSubject:
    user_id: str
    username: str
    tenant_id: str
    permissions: tuple


class AuthError(Exception):
    """Auth verification failure. The handler converts to HTTP 401/403."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _get_secret() -> str:
    secret = os.environ.get("AUTH_JWT_SECRET", "")
    if not secret or len(secret) < 16:
        # Loud failure — without the same secret RDA uses, MLA can't
        # verify anything. Surface this at first auth attempt rather
        # than silently 401-ing every operator request.
        raise AuthError(500, "AUTH_JWT_SECRET not configured on MLA (must match RDA)")
    return secret


def verify_bearer(authorization_header: Optional[str]) -> AuthSubject:
    """
    Parse a `Bearer <jwt>` header and return the verified subject.
    Raises AuthError on any failure.
    """
    if not authorization_header or not authorization_header.lower().startswith("bearer "):
        raise AuthError(401, "Authentication required")

    token = authorization_header[7:].strip()
    if not token:
        raise AuthError(401, "Authentication required")

    try:
        payload = jwt.decode(token, _get_secret(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise AuthError(401, "Token expired")
    except jwt.InvalidTokenError:
        raise AuthError(401, "Invalid token")

    user_id = payload.get("userId")
    username = payload.get("username")
    tenant_id = payload.get("tenantId")
    perms = payload.get("permissions") or []
    if not all(isinstance(x, str) for x in (user_id, username, tenant_id)) or not isinstance(perms, list):
        raise AuthError(401, "Invalid token payload")

    return AuthSubject(
        user_id=user_id,
        username=username,
        tenant_id=tenant_id,
        permissions=tuple(str(p) for p in perms),
    )


def require_permission(subject: AuthSubject, *anyof: str) -> None:
    """
    Raise AuthError(403) unless `subject` has at least one of `anyof`
    (or the wildcard `*`).
    """
    if WILDCARD in subject.permissions:
        return
    if any(p in subject.permissions for p in anyof):
        return
    raise AuthError(403, f"Missing required permission (one of: {', '.join(anyof)})")
