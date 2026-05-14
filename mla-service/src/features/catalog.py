"""
Feature catalogue loader — Python mirror of
``src/shared/features/feature-catalog.ts`` for MLA's training side.

The same JSON files drive both runtimes so train and serve see exactly
the same column order and types. Validation rules mirror the TypeScript
loader; mismatches between the two implementations would be a real bug
worth catching in CI.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


# Indices 64..95 are reserved for adopter features in v1.
ADOPTER_INDEX_START = 64
ADOPTER_INDEX_END_EXCLUSIVE = 96

_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


def _resolve_base_path() -> Path:
    override = os.environ.get("FEATURE_CATALOG_BASE_PATH")
    if override:
        return Path(override).resolve()
    # MLA runs from `mla-service/` natively, so default to the repo-root
    # `models/` directory.
    return (Path(__file__).resolve().parents[3] / "models" / "feature-catalog.v1.json")


def _resolve_overlay_path() -> Path:
    override = os.environ.get("FEATURE_CATALOG_ADOPTER_PATH")
    if override:
        return Path(override).resolve()
    return (Path(__file__).resolve().parents[3] / "models" / "feature-catalog.adopter.json")


@dataclass(frozen=True)
class FeatureSpec:
    index: int
    name: str
    category: str
    source: str
    dtype: str
    default: Any
    description: str
    compute: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class ResolvedCatalog:
    base_version: str
    schema_version: str
    input_dimension: int
    features: Tuple[FeatureSpec, ...]
    by_index: Dict[int, FeatureSpec]
    by_name: Dict[str, FeatureSpec]
    adopter_sha256: Optional[str]


_cache: Optional[ResolvedCatalog] = None


def load_catalog() -> ResolvedCatalog:
    """Load + validate + memoise the merged feature catalogue."""
    global _cache
    if _cache is not None:
        return _cache

    base = _read_base()
    overlay = _read_overlay_if_present()

    merged: List[FeatureSpec] = list(base["features"])
    adopter_sha: Optional[str] = None

    if overlay is not None:
        _validate_overlay(overlay, base)
        merged.extend(overlay["features"])
        adopter_sha = _hash_overlay(overlay)

    _validate_merged(merged, base["input_dimension"] + (len(overlay["features"]) if overlay else 0))

    by_index = {f.index: f for f in merged}
    by_name = {f.name: f for f in merged}

    schema_version = base["version"]
    if adopter_sha:
        schema_version = f"{base['version']}+adopter:{adopter_sha[:12]}"

    _cache = ResolvedCatalog(
        base_version=base["version"],
        schema_version=schema_version,
        input_dimension=len(merged),
        features=tuple(merged),
        by_index=by_index,
        by_name=by_name,
        adopter_sha256=adopter_sha,
    )
    return _cache


def reset_cache_for_tests() -> None:
    """Test-only — clears the memoised catalogue."""
    global _cache
    _cache = None


# ─── internals ────────────────────────────────────────────────────


def _to_spec(d: Dict[str, Any]) -> FeatureSpec:
    return FeatureSpec(
        index=int(d["index"]),
        name=str(d["name"]),
        category=str(d["category"]),
        source=str(d["source"]),
        dtype=str(d["dtype"]),
        default=d.get("default", 0),
        description=str(d.get("description", "")),
        compute=d.get("compute"),
    )


def _read_base() -> Dict[str, Any]:
    path = _resolve_base_path()
    if not path.exists():
        raise RuntimeError(
            f"feature catalogue not found at {path} — set FEATURE_CATALOG_BASE_PATH or ensure the file exists"
        )
    with path.open("r", encoding="utf-8") as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError as err:
            raise RuntimeError(f"feature catalogue at {path} is not valid JSON: {err}") from err

    if not raw.get("version") or not raw.get("input_dimension") or not isinstance(raw.get("features"), list):
        raise RuntimeError(
            "feature catalogue is missing required fields (version, input_dimension, features)"
        )
    if len(raw["features"]) != int(raw["input_dimension"]):
        raise RuntimeError(
            f"feature catalogue declares input_dimension={raw['input_dimension']} "
            f"but contains {len(raw['features'])} features"
        )

    parsed: List[FeatureSpec] = [_to_spec(f) for f in raw["features"]]
    for f in parsed:
        if f.compute is not None:
            raise RuntimeError(
                f"base catalogue feature '{f.name}' has a 'compute' block "
                f"— only adopter overlay features may declare compute"
            )
        _assert_name_legal(f.name)

    return {
        "version": raw["version"],
        "input_dimension": int(raw["input_dimension"]),
        "features": parsed,
        "raw": raw,
    }


def _read_overlay_if_present() -> Optional[Dict[str, Any]]:
    path = _resolve_overlay_path()
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError as err:
            raise RuntimeError(f"adopter overlay at {path} is not valid JSON: {err}") from err
    if raw.get("extends") != "v1":
        raise RuntimeError(
            f"adopter overlay extends '{raw.get('extends')}' — runtime only supports v1"
        )
    if not isinstance(raw.get("features"), list):
        raise RuntimeError("adopter overlay is missing 'features' array")
    return {"features": [_to_spec(f) for f in raw["features"]], "raw": raw}


def _validate_overlay(overlay: Dict[str, Any], base: Dict[str, Any]) -> None:
    overlay_features: List[FeatureSpec] = overlay["features"]
    base_dim: int = base["input_dimension"]
    if len(overlay_features) > ADOPTER_INDEX_END_EXCLUSIVE - ADOPTER_INDEX_START:
        raise RuntimeError(
            f"adopter overlay declares {len(overlay_features)} features — limit is "
            f"{ADOPTER_INDEX_END_EXCLUSIVE - ADOPTER_INDEX_START} "
            f"(indices {ADOPTER_INDEX_START}–{ADOPTER_INDEX_END_EXCLUSIVE - 1})"
        )
    base_names: Set[str] = {f.name for f in base["features"]}
    for f in overlay_features:
        if f.index < base_dim or f.index >= ADOPTER_INDEX_END_EXCLUSIVE:
            raise RuntimeError(
                f"adopter feature '{f.name}' uses index {f.index} — overlay indices must be in "
                f"[{base_dim}, {ADOPTER_INDEX_END_EXCLUSIVE - 1}]"
            )
        if f.name in base_names:
            raise RuntimeError(f"adopter feature '{f.name}' collides with a base catalogue name")
        if f.compute is None:
            raise RuntimeError(
                f"adopter feature '{f.name}' must declare a 'compute' block — see docs/FEATURES.md"
            )
        _assert_name_legal(f.name)


def _validate_merged(features: List[FeatureSpec], expected: int) -> None:
    if len(features) != expected:
        raise RuntimeError(
            f"merged catalogue length {len(features)} disagrees with expected dimension {expected}"
        )
    seen_idx: Set[int] = set()
    seen_name: Set[str] = set()
    for f in features:
        if f.index in seen_idx:
            raise RuntimeError(f"duplicate feature index {f.index}")
        if f.name in seen_name:
            raise RuntimeError(f"duplicate feature name '{f.name}'")
        seen_idx.add(f.index)
        seen_name.add(f.name)
    for i in range(len(features)):
        if i not in seen_idx:
            raise RuntimeError(f"feature catalogue has a gap at index {i}")


def _assert_name_legal(name: str) -> None:
    if not _NAME_PATTERN.match(name):
        raise RuntimeError(
            f"feature name '{name}' is invalid — must match {_NAME_PATTERN.pattern}"
        )


def _hash_overlay(overlay: Dict[str, Any]) -> str:
    """
    Stable SHA-256 of the overlay raw JSON content. We canonicalise keys
    so re-saving the file with different whitespace doesn't change the
    schema-version string.
    """
    canonical = json.dumps(overlay["raw"], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
