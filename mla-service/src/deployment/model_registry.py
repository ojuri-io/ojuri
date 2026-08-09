"""
Model registry — filesystem-backed.

MinIO has been retired from the self-hosted distribution. The flow is
now:

  1. Training writes `models/versions/<version>/{model.onnx,model.pkl,
     scaler.npz,meta.json}` under the repo-root `models/` directory
     (shared bind-mount with RDA).
  2. MLA POSTs `/v1/admin/models` against RDA to record the version
     with `sourceUri = "models/versions/<version>/model.onnx"` (a
     relative path that resolves identically from RDA's container
     WORKDIR and MLA's host cwd).
  3. On McNemar success, MLA POSTs
     `/v1/admin/models/<version>/status` with `ACTIVE` — RDA's
     `ModelRegistryService` fires its `onActiveChange` listener and
     `OnnxService` hot-swaps the loaded session.

Operators can list/retire/delete versions via the admin UI; deleting a
RETIRED row also removes the on-disk version directory. There is no
S3 / object-storage step in this path; the `models/` directory IS the
registry.
"""

import hashlib
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import requests

from src.features.catalog import load_catalog


logger = logging.getLogger(__name__)

# Version labels are constrained to `vMAJOR.MINOR[.PATCH]`. The label is
# used as a path component when reading model artefacts from
# `versions/<label>/...`; without this check, a malicious value like
# `../../etc/passwd` could escape the registry directory entirely. Reject
# anything that doesn't match before touching the filesystem.
VERSION_LABEL_RE = re.compile(r"^v\d+\.\d+(?:\.\d+)?$")


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _assert_safe_version(version: str) -> None:
    if not isinstance(version, str) or not VERSION_LABEL_RE.match(version):
        raise ValueError(
            f"invalid version label: {version!r}. "
            "expected vMAJOR.MINOR[.PATCH] (e.g. v1.2 or v1.2.3)"
        )


# Must stay in step with SPECS in src/shared/onnx/reason-codes.ts. RDA
# keeps the sign (domain knowledge); only magnitudes come from here.
REASON_CODE_FEATURES = (
    "velocity_1h",
    "velocity_24h",
    "velocity_7d",
    "amount_mean_30d",
    "amount_std_30d",
    "graph_pagerank",
    "graph_clustering_coef",
    "pair_time_since_last_send",
    "is_weekend",
    "hour_of_day",
    "amount",
    "transaction_type_code",
)


def _reason_code_weights(model, catalog) -> Optional[Dict[str, float]]:
    try:
        importances = model.feature_importances_
    except Exception as e:
        logger.warning("Could not read feature importances for reason weights: %s", e)
        return None

    weights: Dict[str, float] = {}
    for name in REASON_CODE_FEATURES:
        spec = catalog.by_name.get(name)
        if spec is None or spec.index >= len(importances):
            continue
        value = float(importances[spec.index])
        if value > 0:
            weights[name] = value

    return weights or None


class ModelRegistry:
    """
    Filesystem model registry. Writes to
    ``<MODEL_OUTPUT_DIR>/versions/<version>/`` and, when configured,
    registers the version with RDA via the admin API.

    The contract mirrors the old MinIO-backed class so ``main.py``
    didn't need to change — same method names, same return shapes.
    """

    def __init__(self, config):
        self.config = config

        # Repo-root `models/` is the canonical location — shared with
        # RDA via bind-mount in docker-compose. Default points there;
        # operators can override via MODEL_OUTPUT_DIR for tests.
        self.root = Path(config.MODEL_OUTPUT_DIR).resolve()
        self.versions_dir = self.root / "versions"
        self.versions_dir.mkdir(parents=True, exist_ok=True)

        # Optional RDA bridge. When unset, MLA still writes locally
        # so the operator can `cp` manually or activate via the UI.
        self.rda_api_url: Optional[str] = (
            getattr(config, "RDA_API_URL", None) or os.getenv("RDA_API_URL") or None
        )
        self.rda_token: Optional[str] = (
            getattr(config, "MLA_SERVICE_TOKEN", None)
            or os.getenv("MLA_SERVICE_TOKEN")
            or None
        )

        logger.info("ModelRegistry (filesystem) ready at %s", self.root)
        if not self.rda_api_url or not self.rda_token:
            logger.warning(
                "RDA_API_URL / MLA_SERVICE_TOKEN not configured — "
                "MLA will write versions locally but won't auto-register "
                "with RDA. Activate manually via the admin UI."
            )

    # ───────────────────────────────────────────────────────────
    # Public API (matches the old MinIO-backed class)
    # ───────────────────────────────────────────────────────────
    def upload_model(
        self,
        model,
        model_path: str,
        version: str,
        metadata: dict,
        trigger: str = "drift",
        calibrator=None,
        activate: bool = None,
    ) -> str:
        """
        Materialise a versioned model directory and, if configured,
        register the version with RDA. Whether the version is also
        flipped to ACTIVE depends on ``trigger``:

          - ``"drift"`` (default) — drift detector kicked off the
            retrain. Auto-activate so RDA hot-swaps without operator
            action.
          - ``"initial"`` — cold-start training (``train_initial_model.py``
            or first-boot bootstrap). Auto-activate so ``/v1/predict``
            has a real model immediately.
          - ``"manual"`` — operator pressed "Retrain now" in Sentinel.
            Register as CANDIDATE only; the operator reviews the
            metrics and explicitly clicks ACTIVATE in the model
            registry page. Stops the UI from silently swapping a
            production model under an operator who pressed the button
            for inspection.

        Returns the version label (used by callers for logging).
        """
        _assert_safe_version(version)

        version_dir = self.versions_dir / version
        version_dir.mkdir(parents=True, exist_ok=True)

        onnx_dst = version_dir / "model.onnx"
        booster_dst = version_dir / "model.json"
        scaler_dst = version_dir / "scaler.npz"
        meta_dst = version_dir / "meta.json"

        # 1. ONNX — the artefact RDA loads.
        shutil.copyfile(model_path, onnx_dst)
        sha256 = _sha256_file(str(onnx_dst))
        logger.info("  ✅ ONNX:    %s (sha256 %s)", onnx_dst, sha256[:12])

        # 2. XGBoost native JSON dump — needed for the McNemar A/B test
        # on the next retrain cycle. We deliberately use the native JSON
        # format instead of pickle: an attacker who can write into the
        # versions directory (shared NFS, compromised CI) could otherwise
        # land arbitrary Python via `pickle.load`. JSON is data-only.
        model.save_model(str(booster_dst))
        logger.info("  ✅ Booster: %s", booster_dst)

        # 3. Scaler — co-located so RDA-side ONNX inputs match.
        scaler_src = model_path.replace(".onnx", "_scaler.npz")
        if os.path.exists(scaler_src):
            shutil.copyfile(scaler_src, scaler_dst)
            logger.info("  ✅ Scaler:  %s", scaler_dst)

        # 3b. Isotonic calibrator — previously only the cold-start
        # script persisted it, so every automated retrain silently
        # shipped uncalibrated scores.
        if calibrator is not None and getattr(calibrator, "fitted", False):
            calibrator_dst = version_dir / "calibrator.npz"
            calibrator.save(calibrator_dst)
            logger.info("  ✅ Calibrator: %s", calibrator_dst)

        # 4. Metadata — full training context for the audit trail.
        # `feature_schema_version` is the contract RDA enforces on
        # load: it embeds the base catalogue version plus a SHA of
        # any adopter overlay. If an operator changes the overlay,
        # this string changes, the model bakes the new value into
        # meta.json, and RDA refuses to ACTIVATE older models whose
        # baked version doesn't match the running catalogue.
        catalog = load_catalog()
        meta_payload = {
            **metadata,
            "version": version,
            "sha256": sha256,
            "feature_schema_version": catalog.schema_version,
            "feature_input_dimension": catalog.input_dimension,
            "uploaded_at": datetime.utcnow().isoformat() + "Z",
        }

        # Isotonic breakpoints in JSON so RDA can actually apply the
        # mapping — the .npz above is numpy-native and was never readable
        # from the serving side, so calibration only ever affected the
        # reported Brier score and never a served score.
        if calibrator is not None and getattr(calibrator, "fitted", False):
            meta_payload["calibration"] = calibrator.as_breakpoints()

        # Gain importances for the reason-code features, so the
        # investigator-facing explanation is weighted by what the model
        # learned instead of hand-set constants.
        reason_weights = _reason_code_weights(model, catalog)
        if reason_weights:
            meta_payload["reason_weights"] = reason_weights
        with open(meta_dst, "w") as f:
            json.dump(meta_payload, f, indent=2, default=str)
        logger.info("  ✅ Meta:    %s (schema %s)", meta_dst, catalog.schema_version)

        # 5. RDA registration. The `sourceUri` is a repo-relative path
        # so the same value resolves from both RDA's container WORKDIR
        # and MLA's native cwd. Pass the schema version along so RDA's
        # registry row carries it (the OnnxService check then has the
        # value at hand without round-tripping to disk).
        source_uri = str((Path("models/versions") / version / "model.onnx"))
        self._register_with_rda(
            version=version,
            source_uri=source_uri,
            sha256=sha256,
            metrics=metadata,
            metadata={
                "feature_schema_version": catalog.schema_version,
                "feature_input_dimension": catalog.input_dimension,
                "trained_at": time.time(),
                "trigger": trigger,
            },
            activate=(trigger != "manual") if activate is None else activate,
        )

        logger.info("✅ Model %s materialised at %s", version, version_dir)
        return version

    def get_latest_model(self) -> Optional[Dict[str, Any]]:
        """
        Return the most recent version on disk. Prefers an ACTIVE row
        from the RDA registry when available; otherwise falls back to
        a filesystem mtime scan so cold-start training without an RDA
        connection still picks up the previous run.
        """
        active = self._rda_get_active()
        if active is not None:
            local_path = self._resolve_local(active.get("sourceUri"))
            if local_path and local_path.exists():
                stat = local_path.stat()
                return {
                    "name": active.get("version"),
                    "version": active.get("version"),
                    "size_mb": stat.st_size / (1024 * 1024),
                    "modified": datetime.fromtimestamp(stat.st_mtime),
                    "sha256": active.get("sha256"),
                    "metadata": active.get("metrics") or active.get("metadata") or {},
                }

        # Local-only fallback — pick the newest directory by mtime.
        if not self.versions_dir.exists():
            return None
        candidates = [d for d in self.versions_dir.iterdir() if d.is_dir()]
        if not candidates:
            return None
        latest = max(candidates, key=lambda d: d.stat().st_mtime)
        onnx_path = latest / "model.onnx"
        if not onnx_path.exists():
            return None
        meta = {}
        meta_path = latest / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except Exception as e:
                logger.warning("Couldn't parse %s: %s", meta_path, e)
        return {
            "name": latest.name,
            "version": meta.get("version", latest.name),
            "size_mb": onnx_path.stat().st_size / (1024 * 1024),
            "modified": datetime.fromtimestamp(onnx_path.stat().st_mtime),
            "sha256": meta.get("sha256"),
            "metadata": meta,
        }

    def download_model(
        self,
        object_name: str,
        local_path: str,
        download_booster: bool = True,
    ) -> None:
        """
        Place the ONNX (and optionally the XGBoost JSON booster) for
        `object_name` at `local_path`. With the filesystem registry
        "download" is just a copy — kept name-compatible with the old
        MinIO interface.

        `object_name` is the version label (e.g. ``v1.2.0``); it is
        regex-validated before touching the filesystem so a value like
        ``../other/v1.0`` cannot escape the versions directory.
        """
        _assert_safe_version(object_name)

        src_dir = self.versions_dir / object_name
        # Defence-in-depth: also ensure the resolved path stays inside
        # versions_dir even if a future caller bypasses _assert_safe_version.
        try:
            src_dir.resolve(strict=True).relative_to(self.versions_dir.resolve())
        except (FileNotFoundError, ValueError):
            raise FileNotFoundError(f"Model {object_name} not found in registry")

        onnx_src = src_dir / "model.onnx"
        if not onnx_src.exists():
            raise FileNotFoundError(f"Model {object_name} not found at {onnx_src}")

        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        shutil.copyfile(onnx_src, local_path)
        logger.info("  Copied %s → %s", onnx_src, local_path)

        if download_booster:
            booster_src = src_dir / "model.json"
            if booster_src.exists():
                booster_dst = local_path.replace(".onnx", ".json")
                shutil.copyfile(booster_src, booster_dst)
                logger.info("  Copied %s → %s", booster_src, booster_dst)

    # ───────────────────────────────────────────────────────────
    # RDA bridge (best-effort; service stays usable when offline)
    # ───────────────────────────────────────────────────────────
    def _rda_headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.rda_token}",
        }

    def _register_with_rda(
        self,
        version: str,
        source_uri: str,
        sha256: str,
        metrics: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
        activate: bool = True,
    ) -> None:
        """
        POST /v1/admin/models to create a CANDIDATE row. When
        ``activate`` is true, also POST the status transition to ACTIVE.
        Manual (UI-triggered) retrains pass ``activate=False`` so the
        operator reviews metrics in Sentinel before promoting.

        Failures are warnings, not exceptions — local-only mode is still
        usable for adopters who haven't wired up the service token.
        """
        if not self.rda_api_url or not self.rda_token:
            return

        register_url = f"{self.rda_api_url.rstrip('/')}/v1/admin/models"
        try:
            resp = requests.post(
                register_url,
                headers=self._rda_headers(),
                json={
                    "version": version,
                    "sourceUri": source_uri,
                    "sha256": sha256,
                    # `defaultThreshold` deliberately omitted — keeps
                    # whatever the operator set, falls back to env.
                    "metrics": {k: v for k, v in metrics.items() if isinstance(v, (int, float, str, bool))},
                    "metadata": metadata or {"trained_at": time.time()},
                },
                timeout=10,
            )
            if resp.status_code not in (200, 201, 409):
                logger.warning(
                    "RDA register returned %s: %s — version is on disk; activate via UI",
                    resp.status_code,
                    resp.text[:200],
                )
                return
            logger.info("  ✅ RDA register: %s (%s)", version, resp.status_code)

            if not activate:
                logger.info(
                    "  ⏸  Manual trigger — leaving %s as CANDIDATE for operator review",
                    version,
                )
                return

            activate_url = (
                f"{self.rda_api_url.rstrip('/')}/v1/admin/models/{version}/status"
            )
            resp = requests.post(
                activate_url,
                headers=self._rda_headers(),
                json={"status": "ACTIVE"},
                timeout=10,
            )
            if resp.status_code != 200:
                logger.warning(
                    "RDA activate returned %s: %s — model registered but not ACTIVE",
                    resp.status_code,
                    resp.text[:200],
                )
                return
            logger.info("  ✅ RDA activate: %s ACTIVE", version)
        except requests.RequestException as e:
            logger.warning(
                "RDA bridge unreachable (%s) — model is on disk; activate via UI",
                e,
            )

    def _rda_get_active(self) -> Optional[Dict[str, Any]]:
        if not self.rda_api_url or not self.rda_token:
            return None
        try:
            resp = requests.get(
                f"{self.rda_api_url.rstrip('/')}/v1/admin/models",
                headers=self._rda_headers(),
                timeout=10,
            )
            if resp.status_code != 200:
                return None
            payload = resp.json()
            rows = payload.get("data") if isinstance(payload, dict) else payload
            if not isinstance(rows, list):
                return None
            for r in rows:
                if r.get("status") == "ACTIVE":
                    return r
            return None
        except requests.RequestException:
            return None

    def _resolve_local(self, source_uri: Optional[str]) -> Optional[Path]:
        if not source_uri:
            return None
        if source_uri.startswith("file://"):
            return Path(source_uri[len("file://"):])
        if source_uri.startswith("/"):
            return Path(source_uri)
        # Treat as repo-root-relative. MLA runs from `mla-service/`
        # natively, so resolve against the parent directory unless
        # MODEL_OUTPUT_DIR is set to an absolute path that already
        # includes `models/`.
        repo_root = self.root.parent if self.root.name == "models" else Path.cwd()
        return repo_root / source_uri
