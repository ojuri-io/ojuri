import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { CalibrationSpec } from "./onnx.types";

/**
 * Reads the sidecar `meta.json` MLA writes next to a model — but only if
 * it describes *this* model. The documented manual deploy copies just
 * the `.onnx`, so a stale meta.json left beside it would otherwise
 * supply another booster's calibration and reason weights.
 */
export function readModelMeta(modelFilePath: string): Record<string, unknown> | null {
  const metaPath = path.join(path.dirname(modelFilePath), "meta.json");
  if (!fs.existsSync(metaPath) || !fs.existsSync(modelFilePath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  const declared = meta.sha256;
  if (typeof declared !== "string") return meta;

  const actual = createHash("sha256").update(fs.readFileSync(modelFilePath)).digest("hex");
  return actual === declared ? meta : null;
}

/** Normalised gain importances for the reason-code features, if the
 *  training run emitted them. */
export function loadReasonWeights(modelFilePath: string): Record<string, number> | null {
  const meta = readModelMeta(modelFilePath);
  const block = meta?.reason_weights;
  if (!block || typeof block !== "object") return null;
  const entries = Object.entries(block as Record<string, unknown>).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v)
  ) as Array<[string, number]>;
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function loadCalibration(modelFilePath: string): CalibrationSpec | null {
  const raw = readModelMeta(modelFilePath);
  if (!raw) return null;
  const block = raw.calibration as Record<string, unknown> | undefined;
  if (!block) return null;

  const xThresholds = block.x_thresholds;
  const yThresholds = block.y_thresholds;
  if (!isNumberArray(xThresholds) || !isNumberArray(yThresholds)) return null;
  if (xThresholds.length < 2 || xThresholds.length !== yThresholds.length) return null;
  for (let i = 1; i < xThresholds.length; i++) {
    if (xThresholds[i]! < xThresholds[i - 1]!) return null;
  }

  return { xThresholds, yThresholds };
}

/**
 * Piecewise-linear interpolation over the isotonic breakpoints, clamped
 * at both ends — matches sklearn's `out_of_bounds="clip"`.
 */
export function applyCalibration(spec: CalibrationSpec, raw: number): number {
  const { xThresholds: xs, yThresholds: ys } = spec;
  if (raw <= xs[0]!) return ys[0]!;
  if (raw >= xs[xs.length - 1]!) return ys[ys.length - 1]!;

  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= raw) lo = mid;
    else hi = mid;
  }

  const span = xs[hi]! - xs[lo]!;
  if (span <= 0) return ys[lo]!;
  const t = (raw - xs[lo]!) / span;
  return ys[lo]! + t * (ys[hi]! - ys[lo]!);
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n));
}
