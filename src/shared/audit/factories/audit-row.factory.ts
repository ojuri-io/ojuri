import { Decision } from "@shared/enums/decision.enum";
import { DecisionSource } from "@shared/enums/decision-source.enum";
import { RuleStage } from "@shared/enums/rule-stage.enum";
import { QueuedAuditRecord } from "../decision-audit.types";

export interface AuditInsertRow {
  id: string;
  transactionId: string;
  tenantId: string | null;
  apiKeyId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  senderId: string;
  receiverId: string | null;
  amount: number;
  transactionType: string | null;
  segment: string | null;
  championModelVersion: string;
  shadowModelVersion: string | null;
  championScore: number;
  calibratedScore: number | null;
  shadowScore: number | null;
  threshold: number;
  mlDecision: Decision.ACCEPT | Decision.DECLINE | Decision.REVIEW;
  finalDecision: Decision;
  decisionSource: DecisionSource;
  ruleId: string | null;
  ruleName: string | null;
  ruleStage: RuleStage | null;
  ruleExpression: unknown;
  ruleAction: string | null;
  reasonCodes: unknown;
  featuresSnapshot: unknown;
  featuresDefault: boolean;
  latencyMs: number;
}

class AuditRowFactory {
  static toInsertRow(rec: QueuedAuditRecord): AuditInsertRow {
    const row = {} as AuditInsertRow;

    row.id = rec.id;
    row.transactionId = rec.transactionId;
    row.tenantId = rec.tenantId ?? null;
    row.apiKeyId = rec.apiKeyId ?? null;
    row.correlationId = rec.correlationId ?? null;
    row.idempotencyKey = rec.idempotencyKey ?? null;

    row.senderId = rec.senderId;
    row.receiverId = rec.receiverId ?? null;
    row.amount = rec.amount;
    row.transactionType = rec.transactionType ?? null;
    row.segment = rec.segment ?? null;

    row.championModelVersion = rec.championModelVersion;
    row.shadowModelVersion = rec.shadowModelVersion ?? null;
    row.championScore = rec.championScore;
    row.calibratedScore = rec.calibratedScore ?? null;
    row.shadowScore = rec.shadowScore ?? null;
    row.threshold = rec.threshold;

    row.mlDecision = rec.mlDecision;
    row.finalDecision = rec.finalDecision;
    row.decisionSource = rec.decisionSource;

    row.ruleId = rec.ruleId ?? null;
    row.ruleName = rec.ruleName ?? null;
    row.ruleStage = rec.ruleStage ?? null;
    row.ruleExpression = rec.ruleExpression == null ? null : JSON.stringify(rec.ruleExpression);
    row.ruleAction = rec.ruleAction ?? null;

    row.reasonCodes = rec.reasonCodes == null ? null : JSON.stringify(rec.reasonCodes);
    row.featuresSnapshot = rec.featuresSnapshot == null ? null : JSON.stringify(rec.featuresSnapshot);
    row.featuresDefault = rec.featuresDefault ?? false;

    row.latencyMs = rec.latencyMs;

    return row;
  }
}

export default AuditRowFactory;
