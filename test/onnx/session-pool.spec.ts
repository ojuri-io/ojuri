/**
 * Verifies the round-robin selector on OnnxService. The pool exists so
 * concurrent /predict callers do not all serialize through a single
 * InferenceSession's native execution lock — these tests pin down that
 * the selector hands out sessions evenly and wraps cleanly at the end
 * of each cycle.
 */

import "reflect-metadata";
import { container } from "tsyringe";

import OnnxService from "../../src/shared/onnx/onnx.service";

interface SessionStub {
  run: () => Promise<{ probabilities: { data: Float32Array; dims: number[] } }>;
  __id: number;
}

function makeStubSession(id: number): SessionStub {
  return {
    __id: id,
    run: async () => ({
      probabilities: { data: new Float32Array([0.5, 0.5]), dims: [1, 2] },
    }),
  };
}

describe("OnnxService session-pool round-robin", () => {
  let svc: OnnxService;

  beforeEach(() => {
    container.clearInstances();
    svc = container.resolve(OnnxService);
    (svc as unknown as { isModelLoaded: boolean }).isModelLoaded = true;
  });

  it("rotates through every session in order then wraps", () => {
    const pool = [0, 1, 2, 3].map(makeStubSession);
    (svc as unknown as { sessions: SessionStub[] }).sessions = pool;

    const next = (svc as unknown as { nextSession: () => SessionStub }).nextSession.bind(svc);
    const ids = Array.from({ length: 10 }, () => next().__id);
    expect(ids).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
  });

  it("handles a pool of size 1 by returning the same session repeatedly", () => {
    const pool = [makeStubSession(42)];
    (svc as unknown as { sessions: SessionStub[] }).sessions = pool;

    const next = (svc as unknown as { nextSession: () => SessionStub }).nextSession.bind(svc);
    expect(next().__id).toBe(42);
    expect(next().__id).toBe(42);
    expect(next().__id).toBe(42);
  });

  it("spreads concurrent calls across the pool when invoked via predict", async () => {
    const observed: number[] = [];
    const pool: SessionStub[] = [0, 1, 2, 3].map((id) => ({
      __id: id,
      run: async () => {
        observed.push(id);
        return { probabilities: { data: new Float32Array([0.5, 0.5]), dims: [1, 2] } };
      },
    }));
    (svc as unknown as { sessions: SessionStub[] }).sessions = pool;

    await Promise.all(Array.from({ length: 12 }, () => svc.predict(new Float32Array(64))));

    // Round-robin guarantees every session id appears exactly N/pool times.
    const counts = observed.reduce<Record<number, number>>(
      (acc, id) => ((acc[id] = (acc[id] ?? 0) + 1), acc),
      {},
    );
    expect(counts).toEqual({ 0: 3, 1: 3, 2: 3, 3: 3 });
  });
});
