import "reflect-metadata";
import OnnxService from "../../src/shared/onnx/onnx.service";
import DecisionAuditFactory from "../../src/v1/modules/rda/factories/decision-audit.factory";
import PredictDecisionContextFactory from "../../src/v1/modules/rda/factories/predict-decision-context.factory";
import { Decision } from "../../src/shared/enums/decision.enum";
import { DecisionSource } from "../../src/shared/enums/decision-source.enum";
import { PredictInvocation, PredictRuleHit } from "../../src/v1/modules/rda/services/predict.types";
import { PredictRequestDto } from "../../src/v1/modules/rda/dtos/predict-request.dto";
import { RuleAction } from "../../src/shared/enums/rule-action.enum";
import { RuleStage } from "../../src/shared/enums/rule-stage.enum";

const request = {
  transaction_id: "tx-shadow-1",
  sender_id: "s1",
  receiver_id: "r1",
  amount: 1000,
  transaction_type: "TRANSFER",
  timestamp: 1_700_000_000_000,
} as PredictRequestDto;

const invocation: PredictInvocation = { request, traceId: "t1" };

function mlContextInput(shadowScore: number | null) {
  return {
    invocation,
    request,
    startTime: Date.now(),
    postRule: null,
    finalDecision: Decision.ACCEPT,
    decisionSource: DecisionSource.ML as const,
    mlScore: 0.12,
    mlDecision: Decision.ACCEPT as const,
    threshold: 0.5,
    championVersion: "v1.0",
    shadowVersion: "v1.1",
    shadowScore,
    reasonCodes: [],
    featuresSnapshot: {},
    isDefault: false,
  };
}

describe("shadow scoring", () => {
  it("predictShadow returns null when no shadow model is loaded", async () => {
    const service = new OnnxService();
    expect(service.isShadowLoaded()).toBe(false);
    await expect(service.predictShadow(new Float32Array(64))).resolves.toBeNull();
  });

  it("propagates the shadow score into the audit record", () => {
    const ctx = PredictDecisionContextFactory.fromMlDecision(mlContextInput(0.42));
    const record = DecisionAuditFactory.createRecord(ctx, 5);

    expect(record.shadowModelVersion).toBe("v1.1");
    expect(record.shadowScore).toBe(0.42);
  });

  it("records null shadow score when shadow scoring was unavailable", () => {
    const ctx = PredictDecisionContextFactory.fromMlDecision(mlContextInput(null));
    expect(DecisionAuditFactory.createRecord(ctx, 5).shadowScore).toBeNull();
  });

  it("pre-rule short-circuit never carries a shadow score", () => {
    const rule: PredictRuleHit = {
      rule: { id: "r1", name: "block", action: RuleAction.DENY, expression: { ">": [{ var: "amount" }, 1] } },
      stage: RuleStage.PRE,
    };
    const ctx = PredictDecisionContextFactory.fromPreRule({
      invocation,
      request,
      startTime: Date.now(),
      rule,
      finalDecision: Decision.DECLINE,
      threshold: 0.5,
      championVersion: "v1.0",
      shadowVersion: "v1.1",
      reasonCodes: [],
      featuresSnapshot: {},
      isDefault: false,
    });
    expect(DecisionAuditFactory.createRecord(ctx, 5).shadowScore).toBeNull();
  });
});
