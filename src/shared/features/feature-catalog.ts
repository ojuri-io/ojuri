/**
 * Feature catalogue loader.
 *
 * Reads the base catalogue (`models/feature-catalog.v1.json`) and an
 * optional adopter overlay (`models/feature-catalog.adopter.json`),
 * validates both, and produces a resolved catalogue that the rest of
 * RDA consumes.
 *
 * Hard invariants enforced here (any failure = startup abort):
 *
 *   1. `index` values are contiguous starting at 0; no gaps, no
 *      duplicates.
 *   2. `name` values are unique and match `^[a-z][a-z0-9_]*$`.
 *   3. Base + overlay together = `input_dimension`. Overlay indices
 *      must start at `base.input_dimension` (currently 64) and stay
 *      within 32 slots.
 *   4. Overlay-only features MUST declare `compute`; base features
 *      MUST NOT (they have hand-written RDA code paths).
 *
 * Why "fail closed on bad catalogue" rather than skip: a missing or
 * malformed catalogue at boot means the model contract is unknown —
 * shipping predictions against an unknown contract is the train/serve-
 * skew class we're trying to eliminate.
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import {
  AdopterOverlayFile,
  FeatureCatalogFile,
  FeatureSpec,
  ResolvedCatalog,
} from "./feature-catalog.types";

const BASE_CATALOG_PATH = process.env.FEATURE_CATALOG_BASE_PATH
  ? path.resolve(process.env.FEATURE_CATALOG_BASE_PATH)
  : path.resolve(process.cwd(), "models/feature-catalog.v1.json");

const ADOPTER_OVERLAY_PATH = process.env.FEATURE_CATALOG_ADOPTER_PATH
  ? path.resolve(process.env.FEATURE_CATALOG_ADOPTER_PATH)
  : path.resolve(process.cwd(), "models/feature-catalog.adopter.json");

/** Indices 64..95 are reserved for adopter features in v1. */
const ADOPTER_INDEX_START = 64;
const ADOPTER_INDEX_END_EXCLUSIVE = 96;

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

let cached: ResolvedCatalog | null = null;

/**
 * Load and resolve the feature catalogue. Cached after the first call.
 * Throws on validation failure — callers should let the exception
 * propagate so the boot logs are loud.
 */
export function loadCatalog(): ResolvedCatalog {
  if (cached) return cached;

  const base = readBase();
  const overlay = readAdopterOverlayIfPresent();

  const merged: FeatureSpec[] = [...base.features];
  let adopterSha256: string | null = null;

  if (overlay) {
    validateOverlay(overlay, base);
    merged.push(...overlay.features);
    adopterSha256 = hashJson(overlay);
  }

  validateMerged(merged, base.input_dimension + (overlay?.features.length ?? 0));

  const byIndex = new Map<number, FeatureSpec>(merged.map((f) => [f.index, f]));
  const byName = new Map<string, FeatureSpec>(merged.map((f) => [f.name, f]));

  cached = {
    baseVersion: base.version,
    schemaVersion: adopterSha256
      ? `${base.version}+adopter:${adopterSha256.slice(0, 12)}`
      : base.version,
    inputDimension: merged.length,
    features: Object.freeze(merged),
    byIndex,
    byName,
    adopterSha256,
  };
  return cached;
}

/**
 * Reset the cache. Test-only — RDA never reloads the catalogue at
 * runtime; a change requires a restart.
 */
export function _resetCatalogCacheForTests(): void {
  cached = null;
}

// ─── internals ───────────────────────────────────────────────────

function readBase(): FeatureCatalogFile {
  if (!fs.existsSync(BASE_CATALOG_PATH)) {
    throw new Error(
      `feature catalogue not found at ${BASE_CATALOG_PATH} — set FEATURE_CATALOG_BASE_PATH or ensure the file exists`
    );
  }
  const raw = fs.readFileSync(BASE_CATALOG_PATH, "utf8");
  let parsed: FeatureCatalogFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`feature catalogue at ${BASE_CATALOG_PATH} is not valid JSON: ${err}`);
  }

  if (!parsed.version || !parsed.input_dimension || !Array.isArray(parsed.features)) {
    throw new Error(`feature catalogue is missing required fields (version, input_dimension, features)`);
  }
  if (parsed.features.length !== parsed.input_dimension) {
    throw new Error(
      `feature catalogue declares input_dimension=${parsed.input_dimension} but contains ${parsed.features.length} features`
    );
  }

  validateBase(parsed);
  return parsed;
}

function readAdopterOverlayIfPresent(): AdopterOverlayFile | null {
  if (!fs.existsSync(ADOPTER_OVERLAY_PATH)) return null;
  const raw = fs.readFileSync(ADOPTER_OVERLAY_PATH, "utf8");
  let parsed: AdopterOverlayFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`adopter overlay at ${ADOPTER_OVERLAY_PATH} is not valid JSON: ${err}`);
  }
  if (parsed.extends !== "v1") {
    throw new Error(
      `adopter overlay extends '${parsed.extends}' — runtime only supports v1`
    );
  }
  if (!Array.isArray(parsed.features)) {
    throw new Error(`adopter overlay is missing 'features' array`);
  }
  return parsed;
}

function validateBase(catalog: FeatureCatalogFile): void {
  for (const f of catalog.features) {
    if (f.compute !== undefined) {
      throw new Error(
        `base catalogue feature '${f.name}' has a 'compute' block — only adopter overlay features may declare compute`
      );
    }
    assertNameIsLegal(f.name);
  }
}

function validateOverlay(overlay: AdopterOverlayFile, base: FeatureCatalogFile): void {
  const baseDim = base.input_dimension;
  if (overlay.features.length > ADOPTER_INDEX_END_EXCLUSIVE - ADOPTER_INDEX_START) {
    throw new Error(
      `adopter overlay declares ${overlay.features.length} features — limit is ${
        ADOPTER_INDEX_END_EXCLUSIVE - ADOPTER_INDEX_START
      } (indices ${ADOPTER_INDEX_START}–${ADOPTER_INDEX_END_EXCLUSIVE - 1})`
    );
  }
  const baseNames = new Set(base.features.map((f) => f.name));
  for (const f of overlay.features) {
    if (f.index < baseDim || f.index >= ADOPTER_INDEX_END_EXCLUSIVE) {
      throw new Error(
        `adopter feature '${f.name}' uses index ${f.index} — overlay indices must be in [${baseDim}, ${
          ADOPTER_INDEX_END_EXCLUSIVE - 1
        }]`
      );
    }
    if (baseNames.has(f.name)) {
      throw new Error(
        `adopter feature '${f.name}' collides with a base catalogue name`
      );
    }
    if (!f.compute) {
      throw new Error(
        `adopter feature '${f.name}' must declare a 'compute' block — see docs/FEATURES.md`
      );
    }
    assertNameIsLegal(f.name);
  }
}

function validateMerged(features: FeatureSpec[], expected: number): void {
  if (features.length !== expected) {
    throw new Error(
      `merged catalogue length ${features.length} disagrees with expected dimension ${expected}`
    );
  }
  const seenIdx = new Set<number>();
  const seenName = new Set<string>();
  for (const f of features) {
    if (seenIdx.has(f.index)) {
      throw new Error(`duplicate feature index ${f.index}`);
    }
    if (seenName.has(f.name)) {
      throw new Error(`duplicate feature name '${f.name}'`);
    }
    seenIdx.add(f.index);
    seenName.add(f.name);
  }
  for (let i = 0; i < features.length; i++) {
    if (!seenIdx.has(i)) {
      throw new Error(`feature catalogue has a gap at index ${i}`);
    }
  }
}

function assertNameIsLegal(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `feature name '${name}' is invalid — must match ${NAME_PATTERN}`
    );
  }
}

/**
 * Stable SHA-256 of the overlay file. We hash the canonicalised JSON
 * (keys sorted, no whitespace) so re-saves that only reformat the file
 * don't change the schema-version string.
 */
function hashJson(obj: unknown): string {
  const canonical = JSON.stringify(obj, Object.keys(obj as object).sort());
  return createHash("sha256").update(canonical).digest("hex");
}
