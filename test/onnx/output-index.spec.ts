/**
 * Regression test for the binary-classifier output-index bug fixed in
 * fed3c3c (§6b of fraud-validation-report). XGBoost-via-onnxmltools
 * emits `probabilities` of shape [N, 2] = [P(legit), P(fraud)]. The
 * original implementation read data[0] and reported it as
 * fraud_probability, **inverting every decision**.
 *
 * The runInference logic is private, so we exercise it through
 * `OnnxService.predict()` after stubbing `session.run()` to return a
 * deterministic probabilities tensor. If a future refactor flips the
 * index back to 0 (or drops the `dims[1] === 2` guard), these tests
 * fail loudly.
 */

import "reflect-metadata";
import { container } from "tsyringe";

import OnnxService from "../../src/shared/onnx/onnx.service";

describe("OnnxService output-index handling", () => {
  let svc: OnnxService;

  beforeEach(() => {
    container.clearInstances();
    svc = container.resolve(OnnxService);
    // Force isModelLoaded so runInference doesn't hit the early-return
    // "session not loaded" path. The stub session below replaces the
    // real ort.InferenceSession.
    (svc as unknown as { isModelLoaded: boolean }).isModelLoaded = true;
  });

  it("reads index 1 for binary [P(legit), P(fraud)] tensors", async () => {
    const stub = {
      run: async () => ({
        probabilities: {
          data: new Float32Array([0.91, 0.09]),  // legit-shaped probs
          dims: [1, 2],
        },
      }),
    };
    (svc as unknown as { session: unknown }).session = stub;

    const probability = await svc.predict(new Float32Array(64));
    expect(probability).toBeCloseTo(0.09, 5);
  });

  it("reads index 1 for the inverted fraud-shaped case", async () => {
    const stub = {
      run: async () => ({
        probabilities: {
          data: new Float32Array([0.03, 0.97]),  // fraud-shaped probs
          dims: [1, 2],
        },
      }),
    };
    (svc as unknown as { session: unknown }).session = stub;

    const probability = await svc.predict(new Float32Array(64));
    expect(probability).toBeCloseTo(0.97, 5);
  });

  it("falls back to index 0 for legacy single-output stubs", async () => {
    // `output` (single tensor, dims=[1]) is the legacy stub shape.
    // dims length isn't 2 so the binary-probs branch shouldn't fire.
    const stub = {
      run: async () => ({
        output: {
          data: new Float32Array([0.42]),
          dims: [1],
        },
      }),
    };
    (svc as unknown as { session: unknown }).session = stub;

    const probability = await svc.predict(new Float32Array(64));
    expect(probability).toBeCloseTo(0.42, 5);
  });
});
