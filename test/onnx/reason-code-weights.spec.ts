/**
 * Reason-code weights were hand-set constants, independent of what the
 * deployed model actually learned — and they are the investigator- and
 * regulator-facing explanation. Weights now come from the model's gain
 * importances when training emits them; the sign stays with the spec,
 * since importances are unsigned.
 */

import {
  explain,
  setModelWeights,
  _resetResolvedSpecsForTests,
} from "../../src/shared/onnx/reason-codes";
import { ReasonBasis } from "../../src/shared/onnx/reason-codes.types";
import { loadCatalog } from "../../src/shared/features/feature-catalog";

function vectorWith(values: Record<string, number>): Float32Array {
  const catalog = loadCatalog();
  const v = new Float32Array(catalog.inputDimension);
  for (const [name, value] of Object.entries(values)) {
    v[catalog.byName.get(name)!.index] = value;
  }
  return v;
}

describe("reason-code weighting", () => {
  afterEach(() => _resetResolvedSpecsForTests());

  it("falls back to the built-in heuristic when no model weights are loaded", () => {
    const codes = explain(vectorWith({ amount: 500_000, velocity_1h: 40 }));
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((c) => c.basis === ReasonBasis.HEURISTIC)).toBe(true);
  });

  it("marks codes MODEL_WEIGHTED once importances are supplied", () => {
    setModelWeights({ amount: 90, velocity_1h: 30 });
    const codes = explain(vectorWith({ amount: 500_000, velocity_1h: 40 }));
    const amount = codes.find((c) => c.code === "AMOUNT_HIGH");
    expect(amount?.basis).toBe(ReasonBasis.MODEL_WEIGHTED);
  });

  it("keeps the spec's sign — importances carry magnitude only", () => {
    // graph_pagerank has a negative spec weight (higher centrality =
    // lower risk); a positive importance must not flip that.
    setModelWeights({ graph_pagerank: 100 });
    const codes = explain(vectorWith({ graph_pagerank: 0.02 }), 12);
    const pagerank = codes.find((c) => c.code === "PAGERANK");
    expect(pagerank!.contribution).toBeLessThan(0);
  });

  it("re-ranks codes when the model disagrees with the hand-set ordering", () => {
    const vector = vectorWith({ amount: 500_000, is_weekend: 1 });

    const heuristic = explain(vector, 12);
    const heuristicTop = heuristic[0]!.code;

    // WEEKEND carries the smallest hand-set weight (0.05) against
    // AMOUNT_HIGH's 0.35. A model that leans hard on is_weekend should
    // surface it instead.
    setModelWeights({ is_weekend: 100, amount: 1 });
    const weighted = explain(vector, 12);

    expect(heuristicTop).toBe("AMOUNT_HIGH");
    expect(weighted[0]!.code).toBe("WEEKEND");
  });

  it("ignores unusable weight blocks rather than zeroing every code", () => {
    setModelWeights({ amount: Number.NaN, velocity_1h: -3 });
    const codes = explain(vectorWith({ amount: 500_000 }));
    expect(codes.every((c) => c.basis === ReasonBasis.HEURISTIC)).toBe(true);
  });

  it("leaves features absent from the weight block on the heuristic basis", () => {
    setModelWeights({ amount: 50 });
    const codes = explain(vectorWith({ amount: 500_000, velocity_1h: 40 }), 12);
    expect(codes.find((c) => c.code === "AMOUNT_HIGH")!.basis).toBe(ReasonBasis.MODEL_WEIGHTED);
    expect(codes.find((c) => c.code === "VELOCITY_1H")!.basis).toBe(ReasonBasis.HEURISTIC);
  });
});
