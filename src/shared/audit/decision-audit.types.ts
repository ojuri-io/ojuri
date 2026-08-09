import { Decision } from "@shared/enums/decision.enum";
import { DecisionSource } from "@shared/enums/decision-source.enum";
import { RuleAction } from "@shared/enums/rule-action.enum";
import { RuleStage } from "@shared/enums/rule-stage.enum";
import { ReasonCode } from "@shared/onnx/reason-codes";
import { RuleExpression } from "@shared/rules/rule.types";

export interface DecisionAuditRecord {
  transactionId: string;
  tenantId?: string | null;
  apiKeyId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;

  senderId: string;
  receiverId?: string | null;
  amount: number;
  transactionType?: string | null;
  segment?: string | null;

  championModelVersion: string;
  shadowModelVersion?: string | null;
  championScore: number;
  calibratedScore?: number | null;
  shadowScore?: number | null;
  threshold: number;

  mlDecision: Decision.ACCEPT | Decision.DECLINE | Decision.REVIEW;
  finalDecision: Decision;
  decisionSource: DecisionSource;

  ruleId?: string | null;
  ruleName?: string | null;
  ruleStage?: RuleStage | null;
  ruleExpression?: RuleExpression | null;
  ruleAction?: RuleAction | null;

  reasonCodes?: ReasonCode[] | null;
  featuresSnapshot?: Record<string, number> | null;
  featuresDefault?: boolean;

  latencyMs: number;
}

export type AuditEventPayload = DecisionAuditRecord & { auditId: string };

export type AuditEnrichmentFields = Partial<
  Pick<DecisionAuditRecord, "shadowScore" | "featuresSnapshot" | "featuresDefault" | "reasonCodes">
>;

/** Values that resolve after the immutable decision event has been
 *  published (shadow scores, early-PRE feature snapshots). Applied by
 *  AuditStreamConsumer as an idempotent UPDATE on the audit row. */
export interface AuditEnrichmentEvent {
  audit_id: string;
  fields: AuditEnrichmentFields;
}

export type DecisionAuditRecordResult =
  | { kind: "ok"; id: string }
  | { kind: "duplicate" }
  | { kind: "failed" };

export type QueuedAuditRecord = DecisionAuditRecord & { id: string };

export interface AuditWriteQueueOptions {
  capacity: number;
  flushIntervalMs: number;
  batchSize: number;
}

