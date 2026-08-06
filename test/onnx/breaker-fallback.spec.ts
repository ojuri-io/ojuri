/**
 * The ONNX breaker fails closed: its fallback returns score 1.0. Before
 * this was made distinguishable, that score reached the audit row as an
 * ordinary `decisionSource=ML` DECLINE, so a contention spike produced
 * customer-facing mass declines that were indistinguishable after the
 * fact from genuine model output — and each one dual-published to the
 * blocked topic, flooding FIA.
 */

import "reflect-metadata";
import { container } from "tsyringe";

import OnnxService from "../../src/shared/onnx/onnx.service";

describe("OnnxService breaker fallback", () => {
  let svc: OnnxService;

  beforeEach(() => {
    container.clearInstances();
    svc = container.resolve(OnnxService);
    (svc as unknown as { isModelLoaded: boolean }).isModelLoaded = true;
  });

  it("marks the fallback outcome degraded so callers can tell it apart", async () => {
    (svc as unknown as { sessions: unknown[] }).sessions = [
      { run: async () => { throw new Error("inference exploded"); } },
    ];

    const outcome = await svc.predict(new Float32Array(64));
    expect(outcome.degraded).toBe(true);
    expect(outcome.score).toBe(1.0);
    expect(outcome.calibratedScore).toBeNull();
  });

  it("marks a successful inference not-degraded", async () => {
    (svc as unknown as { sessions: unknown[] }).sessions = [
      {
        run: async () => ({
          probabilities: { data: new Float32Array([0.7, 0.3]), dims: [1, 2] },
        }),
      },
    ];

    const outcome = await svc.predict(new Float32Array(64));
    expect(outcome.degraded).toBe(false);
    expect(outcome.score).toBeCloseTo(0.3, 5);
  });

  it("applies loaded calibration to a live score", async () => {
    (svc as unknown as { sessions: unknown[] }).sessions = [
      {
        run: async () => ({
          probabilities: { data: new Float32Array([0.05, 0.95]), dims: [1, 2] },
        }),
      },
    ];
    (svc as unknown as { calibration: unknown }).calibration = {
      xThresholds: [0, 0.5, 1],
      yThresholds: [0, 0.1, 0.4],
    };

    const outcome = await svc.predict(new Float32Array(64));
    expect(outcome.score).toBeCloseTo(0.95, 5);
    expect(outcome.calibratedScore).toBeCloseTo(0.37, 5);
  });

  it("reports null calibratedScore when no calibrator is loaded", async () => {
    (svc as unknown as { sessions: unknown[] }).sessions = [
      {
        run: async () => ({
          probabilities: { data: new Float32Array([0.4, 0.6]), dims: [1, 2] },
        }),
      },
    ];

    const outcome = await svc.predict(new Float32Array(64));
    expect(outcome.calibratedScore).toBeNull();
  });
});
