import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { applyCalibration, loadCalibration } from "../../src/shared/onnx/calibration";
import { CalibrationSpec } from "../../src/shared/onnx/onnx.types";

const spec: CalibrationSpec = {
  xThresholds: [0.0, 0.2, 0.8, 1.0],
  yThresholds: [0.0, 0.01, 0.35, 0.9],
};

describe("applyCalibration", () => {
  it("interpolates linearly between breakpoints", () => {
    expect(applyCalibration(spec, 0.2)).toBeCloseTo(0.01, 6);
    expect(applyCalibration(spec, 0.8)).toBeCloseTo(0.35, 6);
    expect(applyCalibration(spec, 0.5)).toBeCloseTo(0.18, 6);
  });

  it("clamps outside the fitted range, matching sklearn out_of_bounds=clip", () => {
    expect(applyCalibration(spec, -1)).toBe(0.0);
    expect(applyCalibration(spec, 5)).toBe(0.9);
  });

  it("is monotonic — the property that makes threshold tuning meaningful", () => {
    let previous = -Infinity;
    for (let raw = 0; raw <= 1; raw += 0.01) {
      const y = applyCalibration(spec, raw);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it("pulls XGBoost's saturated scores back toward observed fraud rates", () => {
    expect(applyCalibration(spec, 0.95)).toBeLessThan(0.95);
  });
});

describe("loadCalibration", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ojuri-cal-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeMeta(payload: unknown): string {
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(payload));
    const modelPath = path.join(dir, "model.onnx");
    fs.writeFileSync(modelPath, "onnx-bytes");
    return modelPath;
  }

  it("reads the calibration block MLA bakes into meta.json", () => {
    const modelPath = writeMeta({
      version: "v1.2",
      calibration: { x_thresholds: [0, 0.5, 1], y_thresholds: [0, 0.1, 0.8] },
    });
    expect(loadCalibration(modelPath)).toEqual({
      xThresholds: [0, 0.5, 1],
      yThresholds: [0, 0.1, 0.8],
    });
  });

  it("returns null when meta.json carries no calibration", () => {
    expect(loadCalibration(writeMeta({ version: "v1.2" }))).toBeNull();
  });

  it("returns null when meta.json is absent entirely", () => {
    expect(loadCalibration(path.join(dir, "model.onnx"))).toBeNull();
  });

  // The documented manual deploy copies only the .onnx, so a leftover
  // meta.json would otherwise apply a different booster's mapping.
  it("ignores a meta.json describing a different model", () => {
    const modelPath = writeMeta({
      sha256: "0".repeat(64),
      calibration: { x_thresholds: [0, 1], y_thresholds: [0, 0.5] },
    });
    expect(loadCalibration(modelPath)).toBeNull();
  });

  it("accepts a meta.json whose sha256 matches the model on disk", () => {
    const modelPath = path.join(dir, "model.onnx");
    fs.writeFileSync(modelPath, "onnx-bytes");
    const sha = createHash("sha256").update(fs.readFileSync(modelPath)).digest("hex");
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ sha256: sha, calibration: { x_thresholds: [0, 1], y_thresholds: [0, 0.5] } })
    );
    expect(loadCalibration(modelPath)).not.toBeNull();
  });

  // A malformed block must degrade to raw scores, never throw on the
  // boot path.
  it("rejects mismatched or non-monotonic breakpoints", () => {
    expect(
      loadCalibration(writeMeta({ calibration: { x_thresholds: [0, 1], y_thresholds: [0] } }))
    ).toBeNull();
    expect(
      loadCalibration(
        writeMeta({ calibration: { x_thresholds: [0, 0.9, 0.4], y_thresholds: [0, 0.1, 0.2] } })
      )
    ).toBeNull();
  });
});
