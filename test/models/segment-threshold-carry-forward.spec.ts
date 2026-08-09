/**
 * `segmentThresholds` is keyed (segment, modelVersion) and `resolve()`
 * looks up by the running champion. Activating a new version therefore
 * used to silently drop every per-segment override back to the model
 * default — CASH_OUT 0.70 and TRANSFER 0.30 quietly became whatever the
 * new model's defaultThreshold was, with no log.
 */

import "reflect-metadata";
import ModelRegistryService from "../../src/shared/models/model-registry.service";

interface ThresholdRow {
  segment: string;
  modelVersion: string;
  threshold: number;
  isActive: boolean;
}

function makeRegistry(initial: { versions: any[]; thresholds: ThresholdRow[] }) {
  const state = {
    versions: [...initial.versions],
    thresholds: [...initial.thresholds],
    carryForwardCalls: [] as Array<{ from: string; to: string }>,
  };

  const versionRepo = {
    listAll: async () => state.versions,
    transitionStatus: async (version: string, status: string) => {
      for (const v of state.versions) {
        if (v.status === status) v.status = "RETIRED";
      }
      const row = state.versions.find((v) => v.version === version);
      if (row) row.status = status;
      return row;
    },
  } as never;

  const thresholdRepo = {
    listActive: async () => state.thresholds.filter((t) => t.isActive),
    carryForward: async (from: string, to: string) => {
      state.carryForwardCalls.push({ from, to });
      const source = state.thresholds.filter((t) => t.modelVersion === from && t.isActive);
      let copied = 0;
      for (const row of source) {
        const exists = state.thresholds.some(
          (t) => t.segment === row.segment && t.modelVersion === to
        );
        if (exists) continue;
        state.thresholds.push({ ...row, modelVersion: to });
        copied++;
      }
      return copied;
    },
  } as never;

  const runtimeSettings = {
    getFraudThreshold: (fallback: number) => fallback,
    getReviewMargin: (fallback: number) => fallback,
  } as never;

  const svc = new ModelRegistryService(versionRepo, thresholdRepo, runtimeSettings);
  return { svc, state };
}

const V1 = { version: "v1.0", status: "ACTIVE", sourceUri: "a.onnx", defaultThreshold: 0.65 };
const V2 = { version: "v2.0", status: "CANDIDATE", sourceUri: "b.onnx", defaultThreshold: 0.65 };

describe("segment thresholds across model activation", () => {
  it("carries active overrides forward onto the incoming champion", async () => {
    const { svc, state } = makeRegistry({
      versions: [{ ...V1 }, { ...V2 }],
      thresholds: [
        { segment: "CASH_OUT", modelVersion: "v1.0", threshold: 0.7, isActive: true },
        { segment: "TRANSFER", modelVersion: "v1.0", threshold: 0.3, isActive: true },
      ],
    });
    await svc.reload();

    expect(svc.resolve("CASH_OUT").threshold).toBe(0.7);
    await svc.setStatus("v2.0", "ACTIVE");

    expect(state.carryForwardCalls).toEqual([{ from: "v1.0", to: "v2.0" }]);
    expect(svc.resolve("CASH_OUT").threshold).toBe(0.7);
    expect(svc.resolve("TRANSFER").threshold).toBe(0.3);
  });

  it("does not overwrite overrides already tuned on the incoming version", async () => {
    const { svc } = makeRegistry({
      versions: [{ ...V1 }, { ...V2 }],
      thresholds: [
        { segment: "CASH_OUT", modelVersion: "v1.0", threshold: 0.7, isActive: true },
        { segment: "CASH_OUT", modelVersion: "v2.0", threshold: 0.55, isActive: true },
      ],
    });
    await svc.reload();
    await svc.setStatus("v2.0", "ACTIVE");

    expect(svc.resolve("CASH_OUT").threshold).toBe(0.55);
  });

  it("leaves non-ACTIVE transitions alone", async () => {
    const { svc, state } = makeRegistry({
      versions: [{ ...V1 }, { ...V2 }],
      thresholds: [{ segment: "CASH_OUT", modelVersion: "v1.0", threshold: 0.7, isActive: true }],
    });
    await svc.reload();
    await svc.setStatus("v2.0", "SHADOW");

    expect(state.carryForwardCalls).toEqual([]);
  });

  it("falls back to the model default for a segment with no override at all", async () => {
    const { svc } = makeRegistry({ versions: [{ ...V1 }], thresholds: [] });
    await svc.reload();
    expect(svc.resolve("PAYMENT").threshold).toBe(0.65);
  });
});
