import { Decision } from "@shared/enums/decision.enum";
import { PredictResponseDto } from "../dtos/predict-request.dto";
import { PredictDecisionContext } from "../services/predict.types";
import { round4 } from "../utils/round";

class PredictResponseFactory {
  static create(
    ctx: PredictDecisionContext,
    auditId: string | null,
    latencyMs: number,
  ): PredictResponseDto {
    return {
      transaction_id: ctx.request.transaction_id,
      fraud: ctx.finalDecision === Decision.DECLINE,
      fraud_probability: round4(ctx.mlScore),
      decision: ctx.finalDecision,
      decision_source: ctx.decisionSource,
      reason_codes: ctx.reasonCodes ?? [],
      model_version: ctx.championVersion,
      threshold: ctx.threshold,
      rule: ctx.rule
        ? { id: ctx.rule.rule.id, name: ctx.rule.rule.name, stage: ctx.rule.stage }
        : undefined,
      audit_id: auditId ?? undefined,
      latency_ms: latencyMs,
      timestamp: Date.now(),
    };
  }
}

export default PredictResponseFactory;
