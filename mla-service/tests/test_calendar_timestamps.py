"""
transactions.timestamp is a bigint of Unix MILLISECONDS. The pre-fix
loader passed the raw integers to pd.to_datetime, which treats them as
nanoseconds — every row landed within seconds of 1970-01-01, so
hour_of_day/day_of_week/is_weekend/is_payday_window/is_off_hours were
constants at training time while RDA served live (differently wrong)
values: silent train/serve skew across all five calendar features.
"""

import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.training.data_loader import DataLoader, _parse_event_ts


def _loader() -> DataLoader:
    return object.__new__(DataLoader)


def _ms(*args) -> int:
    return int(datetime(*args, tzinfo=timezone.utc).timestamp() * 1000)


def test_parse_event_ts_treats_integers_as_milliseconds():
    ts = _parse_event_ts(pd.Series([_ms(2026, 7, 6, 14, 30)]))
    assert ts.iloc[0].year == 2026
    assert ts.iloc[0].hour == 14


def test_parse_event_ts_passes_datetimes_through():
    ts = _parse_event_ts(pd.Series(pd.to_datetime(["2026-07-06T14:30:00Z"])))
    assert ts.iloc[0].hour == 14


def test_safe_time_field_hour_of_day_from_ms():
    df = pd.DataFrame({"timestamp": [_ms(2026, 7, 6, 14, 30), _ms(2026, 7, 4, 23, 10)]})
    hours = DataLoader._safe_time_field(_loader(), df, lambda ts: ts.dt.hour, 0.0)
    assert list(hours) == [14.0, 23.0]


def test_safe_time_field_weekend_from_ms():
    df = pd.DataFrame({"timestamp": [_ms(2026, 7, 4, 12, 0), _ms(2026, 7, 6, 12, 0)]})
    weekend = DataLoader._safe_time_field(
        _loader(), df, lambda ts: ts.dt.dayofweek.isin([5, 6]).astype("int8"), 0.0
    )
    assert list(weekend) == [1.0, 0.0]


def test_row_now_ts_returns_epoch_seconds_of_latest_row():
    df = pd.DataFrame({"timestamp": [_ms(2026, 7, 1, 0, 0), _ms(2026, 7, 6, 14, 30)]})
    now_ts = DataLoader._row_now_ts(df)
    assert abs(now_ts - _ms(2026, 7, 6, 14, 30) / 1000.0) < 1.0


def test_safe_time_field_falls_back_on_garbage():
    df = pd.DataFrame({"timestamp": [{"not": "a-timestamp"}, {"also": "bad"}]})
    out = DataLoader._safe_time_field(_loader(), df, lambda ts: ts.dt.hour, 7.0)
    assert list(out) == [7.0, 7.0]
