import { loadCatalog } from "@shared/features/feature-catalog";
import {
  explain,
  REASON_CODE_CATALOGUE,
  _resetResolvedSpecsForTests,
} from "@shared/onnx/reason-codes";

describe("reason-codes", () => {
  beforeEach(() => {
    _resetResolvedSpecsForTests();
  });

  const zeroVector = () => new Float32Array(loadCatalog().inputDimension);

  it("resolves every spec against the feature catalogue", () => {
    expect(() => explain(zeroVector(), 12)).not.toThrow();
    expect(explain(zeroVector(), 12)).toHaveLength(12);
  });

  it("exposes a catalogue of unique reason codes", () => {
    const codes = REASON_CODE_CATALOGUE.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("AMOUNT_HIGH");
    expect(codes).toContain("VELOCITY_1H");
  });

  it("attributes AMOUNT_HIGH to the catalogue's amount position", () => {
    const catalog = loadCatalog();
    const vector = zeroVector();
    vector[catalog.byName.get("amount")!.index] = 5_000_000;

    const [top] = explain(vector, 1);
    expect(top.code).toBe("AMOUNT_HIGH");
    expect(top.value).toBe(5_000_000);
    expect(top.contribution).toBeGreaterThan(0);
  });

  it("reads VELOCITY_1H from velocity_1h, not the legacy index 0", () => {
    const catalog = loadCatalog();
    const vector = zeroVector();
    vector[catalog.byName.get("velocity_1m")!.index] = 500;
    vector[catalog.byName.get("velocity_1h")!.index] = 40;

    const velocity1h = explain(vector, 12).find((c) => c.code === "VELOCITY_1H");
    expect(velocity1h?.value).toBe(40);
    expect(velocity1h?.contribution).toBeCloseTo(0.3 * Math.tanh((40 - 1) / 5), 3);
  });

  it("reports PAGERANK at realistic magnitudes without saturating", () => {
    const vector = zeroVector();
    const [top] = explain(vector, 12).filter((c) => c.code === "PAGERANK");
    expect(Math.abs(top.contribution)).toBeLessThan(0.1);
  });
});
