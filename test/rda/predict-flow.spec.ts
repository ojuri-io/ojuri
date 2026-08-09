/**
 * Covers the interactions a unit test of any single piece would miss:
 * a degraded score must not reach the blocked topic, a request-only rule
 * must not wait on Redis, and a failed prediction must free its
 * transaction_id reservation.
 */

import "reflect-metadata";
import PredictService from "../../src/v1/modules/rda/services/predict.service";
import { Decision } from "../../src/shared/enums/decision.enum";
import { DecisionSource } from "../../src/shared/enums/decision-source.enum";
import { RuleAction } from "../../src/shared/enums/rule-action.enum";
import { RuleStage } from "../../src/shared/enums/rule-stage.enum";
import { PredictInvocation } from "../../src/v1/modules/rda/services/predict.types";
import { PredictRequestDto } from "../../src/v1/modules/rda/dtos/predict-request.dto";
import appConfig from "../../src/config/app.config";

const request = {
  transaction_id: "tx-1",
  sender_id: "s1",
  receiver_id: "r1",
  amount: 900_000,
  transaction_type: "TRANSFER",
  timestamp: 1_700_000_000_000,
  ip_is_vpn: true,
} as PredictRequestDto;

const invocation: PredictInvocation = { request, traceId: "t1" };

interface Harness {
  svc: PredictService;
  featureLoads: () => number;
  publishes: Array<{ topic?: string }>;
  audits: Array<Record<string, unknown>>;
  patches: Array<[string, Record<string, unknown>]>;
  released: string[];
  shadowCalls: () => number;
}

function harness(opts: {
  degraded?: boolean;
  score?: number;
  calibratedScore?: number | null;
  preRuleHit?: boolean;
  requestOnlyHit?: boolean;
  shadowVersion?: string | null;
  featureLoadDelayMs?: number;
  throwOnInference?: boolean;
}): Harness {
  let featureLoads = 0;
  let shadowCalls = 0;
  const publishes: Array<{ topic?: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const patches: Array<[string, Record<string, unknown>]> = [];
  const released: string[] = [];

  const featureService = {
    getFeatures: async () => {
      featureLoads++;
      if (opts.featureLoadDelayMs) {
        await new Promise((r) => setTimeout(r, opts.featureLoadDelayMs));
      }
      return { snapshot: { velocity_1h: 7 }, isDefault: false };
    },
    isReady: () => true,
  };

  const onnxService = {
    predict: async () => {
      if (opts.throwOnInference) throw new Error("inference blew up");
      return {
        score: opts.score ?? 0.2,
        calibratedScore: opts.calibratedScore ?? null,
        degraded: opts.degraded ?? false,
      };
    },
    predictShadow: async () => {
      shadowCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return 0.77;
    },
    isReady: () => true,
  };

  const hit = {
    rule: {
      id: "r1",
      name: "vpn-block",
      action: RuleAction.DENY,
      expression: { "==": [{ var: "ip_is_vpn" }, true] },
    },
    stage: RuleStage.PRE,
  };

  const rulesService = {
    evaluateRequestOnlyPre: () => (opts.requestOnlyHit ? hit : null),
    evaluate: (stage: string) =>
      opts.preRuleHit && stage === RuleStage.PRE ? hit : null,
  };

  const modelRegistry = {
    resolve: () => ({
      championVersion: "v1.0",
      shadowVersion: opts.shadowVersion ?? null,
      threshold: 0.65,
      reviewThreshold: null,
    }),
  };

  const decisionAudit = {
    enqueue: (rec: Record<string, unknown>) => {
      audits.push(rec);
      return "audit-1";
    },
    patchLate: (id: string, fields: Record<string, unknown>) => {
      patches.push([id, fields]);
    },
  };

  const kafkaProducer = {
    publishAsync: (_e: unknown, topic?: string) => publishes.push({ topic }),
  };

  const webhookService = { publish: async () => undefined };

  const idempotencyService = {
    reserveTransactionId: async () => true,
    releaseTransactionId: async (_t: string, txn: string) => {
      released.push(txn);
    },
  };

  const svc = new PredictService(
    featureService as never,
    onnxService as never,
    kafkaProducer as never,
    rulesService as never,
    modelRegistry as never,
    decisionAudit as never,
    webhookService as never,
    idempotencyService as never,
  );

  return {
    svc,
    featureLoads: () => featureLoads,
    publishes,
    audits,
    patches,
    released,
    shadowCalls: () => shadowCalls,
  };
}

function flushAsync(ms = 120): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("breaker fallback on the decision path", () => {
  it("degrades to REVIEW instead of declining the customer", async () => {
    const h = harness({ degraded: true, score: 1.0 });
    const outcome = await h.svc.executePrediction(invocation);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.decision).toBe(Decision.REVIEW);
    expect(outcome.response.decision_source).toBe(DecisionSource.BREAKER_FALLBACK);
  });

  it("records the degraded source so the audit row is not read as a model verdict", async () => {
    const h = harness({ degraded: true, score: 1.0 });
    await h.svc.executePrediction(invocation);

    expect(h.audits[0]!.decisionSource).toBe(DecisionSource.BREAKER_FALLBACK);
    expect(h.audits[0]!.championScore).toBe(1.0);
  });

  it("does not flood FIA: a degraded decline skips the blocked topic", async () => {
    const original = appConfig.circuitBreaker.onnx.fallbackDecision;
    (appConfig.circuitBreaker.onnx as { fallbackDecision: Decision }).fallbackDecision =
      Decision.DECLINE;
    try {
      const h = harness({ degraded: true, score: 1.0 });
      await h.svc.executePrediction(invocation);
      await flushAsync(20);

      expect(h.publishes).toHaveLength(1);
      expect(h.publishes[0]!.topic).toBeUndefined();
    } finally {
      (appConfig.circuitBreaker.onnx as { fallbackDecision: Decision }).fallbackDecision = original;
    }
  });

  it("still dual-publishes a genuine model decline", async () => {
    const h = harness({ score: 0.99 });
    await h.svc.executePrediction(invocation);
    await flushAsync(20);

    expect(h.publishes).toHaveLength(2);
    expect(h.publishes[1]!.topic).toBe(appConfig.kafka.blockedTopic);
  });
});

describe("request-only PRE rules", () => {
  it("decides without blocking on the Redis feature read", async () => {
    const h = harness({ requestOnlyHit: true });
    const outcome = await h.svc.executePrediction(invocation);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.decision).toBe(Decision.DECLINE);
    expect(outcome.response.decision_source).toBe(DecisionSource.PRE_RULE);
    // Null, not empty — the rule decided without loading features, which
    // must not be recorded as "Redis missed, scored on defaults".
    expect(h.audits[0]!.featuresSnapshot).toBeNull();
    expect(h.audits[0]!.featuresDefault).toBe(false);
  });

  it("still lands the feature snapshot on the audit row, just late", async () => {
    const h = harness({ requestOnlyHit: true });
    await h.svc.executePrediction(invocation);
    await flushAsync();

    expect(h.patches).toHaveLength(1);
    const [id, fields] = h.patches[0]!;
    expect(id).toBe("audit-1");
    expect((fields.featuresSnapshot as Record<string, number>).velocity_1h).toBe(7);
    expect(Array.isArray(fields.reasonCodes)).toBe(true);
  });

  it("falls through to the full pass when no request-only rule matches", async () => {
    const h = harness({ score: 0.2 });
    const outcome = await h.svc.executePrediction(invocation);

    expect(h.featureLoads()).toBe(1);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.decision).toBe(Decision.ACCEPT);
  });
});

describe("shadow scoring", () => {
  it("does not block the response on the shadow session", async () => {
    const h = harness({ score: 0.2, shadowVersion: "v1.1" });
    const started = Date.now();
    await h.svc.executePrediction(invocation);
    const elapsed = Date.now() - started;

    // predictShadow sleeps 50 ms; awaiting it would show up here.
    expect(elapsed).toBeLessThan(40);
    expect(h.audits[0]!.shadowScore).toBeNull();
  });

  it("patches the shadow score onto the queued row when it resolves in time", async () => {
    const h = harness({ score: 0.2, shadowVersion: "v1.1" });
    await h.svc.executePrediction(invocation);
    await flushAsync();

    expect(h.patches).toContainEqual(["audit-1", { shadowScore: 0.77 }]);
  });

  it("skips shadow scoring entirely when no shadow model is registered", async () => {
    const h = harness({ score: 0.2, shadowVersion: null });
    await h.svc.executePrediction(invocation);
    await flushAsync(20);

    expect(h.shadowCalls()).toBe(0);
  });
});

describe("calibration in observe mode", () => {
  it("records the calibrated score without moving the decision boundary", async () => {
    const h = harness({ score: 0.9, calibratedScore: 0.31 });
    const outcome = await h.svc.executePrediction(invocation);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // 0.9 >= 0.65 threshold → DECLINE on the raw score; the calibrated
    // 0.31 would have been an ACCEPT and must not be used yet.
    expect(outcome.response.decision).toBe(Decision.DECLINE);
    expect(h.audits[0]!.calibratedScore).toBe(0.31);
    expect(h.audits[0]!.championScore).toBe(0.9);
  });
});

describe("transaction_id reservation", () => {
  it("releases the reservation when the prediction throws", async () => {
    const h = harness({ throwOnInference: true });
    await expect(h.svc.executePrediction(invocation)).rejects.toThrow("inference blew up");
    expect(h.released).toEqual(["tx-1"]);
  });

  it("keeps the reservation on a successful prediction", async () => {
    const h = harness({ score: 0.2 });
    await h.svc.executePrediction(invocation);
    expect(h.released).toEqual([]);
  });
});
