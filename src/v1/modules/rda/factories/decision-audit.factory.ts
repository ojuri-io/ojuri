import { DecisionAuditRecord } from "@shared/audit/decision-audit.types";
import { PredictDecisionContext } from "../services/predict.types";

class DecisionAuditFactory {
  static createRecord(ctx: PredictDecisionContext, latencyMs: number): DecisionAuditRecord {
    const { invocation, request, rule } = ctx;
    const record = {} as DecisionAuditRecord;

    record.transactionId = request.transaction_id;
    record.tenantId = invocation.tenantId ?? null;
    record.apiKeyId = invocation.apiKeyId ?? null;
    record.correlationId = invocation.traceId;
    record.idempotencyKey = invocation.idempotencyKey ?? null;

    record.senderId = request.sender_id;
    record.receiverId = request.receiver_id;
    record.amount = request.amount;
    record.transactionType = request.transaction_type;
    record.segment = request.segment ?? null;

    record.championModelVersion = ctx.championVersion;
    record.shadowModelVersion = ctx.shadowVersion;
    record.championScore = ctx.mlScore;
    record.calibratedScore = ctx.calibratedScore;
    record.shadowScore = ctx.shadowScore;
    record.threshold = ctx.threshold;

    record.mlDecision = ctx.mlDecision;
    record.finalDecision = ctx.finalDecision;
    record.decisionSource = ctx.decisionSource;

    record.ruleId = rule?.rule.id ?? null;
    record.ruleName = rule?.rule.name ?? null;
    record.ruleStage = rule?.stage ?? null;
    record.ruleExpression = rule?.rule.expression ?? null;
    record.ruleAction = rule?.rule.action ?? null;

    record.reasonCodes = ctx.reasonCodes;
    record.featuresSnapshot = ctx.featuresSnapshot;
    record.featuresDefault = ctx.isDefault;

    record.latencyMs = latencyMs;

    return record;
  }
}

export default DecisionAuditFactory;
