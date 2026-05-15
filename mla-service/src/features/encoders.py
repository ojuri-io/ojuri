"""
Python mirror of `src/shared/features/encoders.ts`.

These tables MUST stay in lock-step with the TS encoders — any change
here without the matching TS edit (or vice versa) creates a silent
train/serve skew. The `feature_schema_version` enforcement at RDA load
time is the loud-failure mechanism; this module is just the Python
half of the contract.

Vectorised wrappers (`encode_*_series`) operate on pandas Series so the
training data_loader can build columns in one shot.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd


# ── Categorical encoders (mirror TS exactly) ────────────────────

_TXN_TYPE = {
    "": 0, "CASH_IN": 1, "CASH_OUT": 2, "PAYMENT": 3, "TRANSFER": 4,
    "DEBIT": 5, "PAYOUT": 6, "WITHDRAWAL": 7,
}

_CHANNEL = {
    "": 0, "USSD": 1, "MOBILE": 2, "WEB": 3, "AGENT": 4,
    "POS": 5, "ATM": 6, "API": 7,
}

_CURRENCY = {
    "": 0, "NGN": 1, "USD": 2, "EUR": 3, "GBP": 4,
    "ZAR": 5, "KES": 6, "GHS": 7,
}

_ID_TYPE = {
    "": 0, "BVN": 1, "NIN": 2, "PASSPORT": 3, "DRIVERS_LICENSE": 4,
    "NATIONAL_ID": 5, "VOTERS_CARD": 6, "OTHER_ID": 7,
}

_COUNTRY = {
    "NG": 1, "GH": 2, "KE": 3, "ZA": 4, "EG": 5,
    "US": 6, "GB": 7, "DE": 8, "FR": 9, "IN": 10,
    "CN": 11, "AE": 12,
}

_DEVICE_TYPE = {
    "": 0, "MOBILE": 1, "WEB": 2, "USSD": 3, "POS": 4,
    "AGENT_TERMINAL": 5, "ATM": 6,
}


def _encode_series(series: pd.Series, table: dict, unknown: int = 0) -> pd.Series:
    """Upper-case, strip, map through `table`. Unknowns → `unknown`."""
    return (
        series.fillna("")
        .astype(str)
        .str.upper()
        .str.strip()
        .map(table)
        .fillna(unknown)
    )


def encode_transaction_type(series: pd.Series) -> pd.Series:
    return _encode_series(series, _TXN_TYPE, unknown=0)


def encode_channel(series: pd.Series) -> pd.Series:
    return _encode_series(series, _CHANNEL, unknown=0)


def encode_currency(series: pd.Series) -> pd.Series:
    return _encode_series(series, _CURRENCY, unknown=0)


def encode_id_type(series: pd.Series) -> pd.Series:
    return _encode_series(series, _ID_TYPE, unknown=0)


def encode_device_type(series: pd.Series) -> pd.Series:
    return _encode_series(series, _DEVICE_TYPE, unknown=0)


def encode_country(series: pd.Series) -> pd.Series:
    """Unknowns map to 255 (TS reserves 0 for missing, 255 for OTHER)."""
    upper = series.fillna("").astype(str).str.upper().str.strip()
    # Missing → 0; recognised → code; unrecognised non-empty → 255.
    out = upper.map(_COUNTRY)
    out = out.where(upper != "", 0)
    return out.fillna(255).astype("float32")


# ── Numeric helpers ─────────────────────────────────────────────


def safe_number_series(series: pd.Series, fallback: float = 0.0) -> pd.Series:
    return pd.to_numeric(series, errors="coerce").fillna(fallback)


def safe_bool_series(series: pd.Series) -> pd.Series:
    """Coerce arbitrary booleans / 0/1 / 'yes'/'no' strings to {0, 1}."""
    if series.dtype == bool:
        return series.astype("int8")
    truthy = series.fillna("").astype(str).str.strip().str.lower()
    return truthy.isin(["true", "yes", "y", "1"]).astype("int8")


def haversine_km(
    lat1: pd.Series, lng1: pd.Series, lat2: pd.Series, lng2: pd.Series
) -> pd.Series:
    """Vectorised great-circle distance in km. Missing inputs → 0."""
    a = safe_number_series(lat1, np.nan)
    b = safe_number_series(lng1, np.nan)
    c = safe_number_series(lat2, np.nan)
    d = safe_number_series(lng2, np.nan)

    mask = a.notna() & b.notna() & c.notna() & d.notna()
    if not mask.any():
        return pd.Series(np.zeros(len(a)), index=a.index)

    R = 6371.0
    lat1r = np.radians(a)
    lat2r = np.radians(c)
    dlat = np.radians(c - a)
    dlng = np.radians(d - b)
    h = (
        np.sin(dlat / 2.0) ** 2
        + np.cos(lat1r) * np.cos(lat2r) * np.sin(dlng / 2.0) ** 2
    )
    out = 2.0 * R * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
    return pd.Series(out, index=a.index).where(mask, 0.0)


def age_days_series(dob_series: pd.Series, now_ts: float) -> pd.Series:
    """Days between an ISO/date column and `now_ts` (epoch seconds)."""
    try:
        parsed = pd.to_datetime(dob_series, errors="coerce", utc=True)
    except Exception:
        return pd.Series(np.zeros(len(dob_series)), index=dob_series.index)
    now = datetime.fromtimestamp(now_ts, tz=timezone.utc)
    diff = (now - parsed).dt.total_seconds() / 86400.0
    return diff.fillna(0).clip(lower=0)
