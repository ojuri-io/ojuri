import { Decision } from "../enums/decision.enum.js";
import { DecisionSource } from "../enums/decision-source.enum.js";
import { ReviewOrder } from "../enums/review-order.enum.js";
import { RuleAction } from "../enums/rule-action.enum.js";
import { RuleStage } from "../enums/rule-stage.enum.js";
import { TransactionType } from "../enums/transaction-type.enum.js";
import { ReasonCode } from "./predict.types.js";

// Field names mirror `decisionAuditLog` exactly: the audit routes return the
// Objection model unmapped, so any rename here silently reads undefined.
export interface DecisionAuditRow {
  id: string;
  transactionId: string;
  tenantId: string | null;
  apiKeyId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;

  senderId: string;
  receiverId: string | null;
  amount: string | number;
  transactionType: `${TransactionType}` | null;
  segment: string | null;

  championModelVersion: string;
  shadowModelVersion: string | null;
  championScore: number;
  calibratedScore: number | null;
  shadowScore: number | null;
  threshold: number;

  mlDecision: `${Decision}`;
  finalDecision: `${Decision}`;
  decisionSource: `${DecisionSource}`;

  ruleId: string | null;
  ruleName: string | null;
  ruleStage: `${RuleStage}` | null;
  ruleExpression: unknown;
  ruleAction: `${RuleAction}` | null;

  reasonCodes: ReasonCode[] | null;
  featuresSnapshot: Record<string, number> | null;
  featuresDefault: boolean;

  reviewedBy: string | null;
  reviewedAt: string | null;
  overrideDecision: `${Decision}` | null;
  overrideReason: string | null;

  latencyMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewQueuePage {
  rows: DecisionAuditRow[];
  total: number;
  limit: number;
  offset: number;
  oldestPendingAt: string | null;
  totalPendingAmount: number | string | null;
}

export interface ReviewQueueQuery {
  limit?: number;
  offset?: number;
  order?: `${ReviewOrder}`;
  search?: string;
}

export interface RecentDecisionsQuery {
  since?: Date | string;
  limit?: number;
}

export interface OverrideDecisionInput {
  decision: `${Decision.ACCEPT}` | `${Decision.DECLINE}`;
  reason?: string;
}
