"""
Adopter extension point for code-based feature resolvers (training side).

Mirrors `src/shared/features/custom-features.ts`. Each registered name
maps to a function that takes the training DataFrame plus the catalogue
spec and returns a numpy column of length `len(df)`. Pair this with a
TS resolver of the same name in `src/shared/features/custom-features.ts`
or your adopter wrapper — both sides MUST produce the same value for
the same inputs or the model trains on one number and serves another.

Registration is at module load. The MLA process imports the adopter's
module before `DataLoader().load_training_data()` runs; typically the
adopter creates `mla-service/src/adopter/features.py` and imports it
from `src/main.py` (or any module that's loaded at startup).

Resolver contract:

    def fn(df: pd.DataFrame, spec: FeatureSpec) -> np.ndarray

    • Return length MUST be `len(df)`.
    • Return dtype is coerced to float32 by the caller.
    • Missing / non-finite values should be replaced with `spec.default`
      before returning — the caller does a fillna(default) safety pass
      but failures still pollute the column variance.
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

from src.features.catalog import FeatureSpec


logger = logging.getLogger(__name__)


CustomFeatureResolver = Callable[[pd.DataFrame, FeatureSpec], np.ndarray]


_registry: Dict[str, CustomFeatureResolver] = {}


def register_custom_feature(name: str, fn: CustomFeatureResolver) -> None:
    """
    Register a resolver. Idempotent — registering the same name twice
    overwrites silently so adopters can re-import during development
    without restarting the whole process.
    """
    _registry[name] = fn


def get_custom_feature(name: str) -> Optional[CustomFeatureResolver]:
    return _registry.get(name)


def list_custom_features() -> List[str]:
    return sorted(_registry.keys())


def reset_for_tests() -> None:
    _registry.clear()
