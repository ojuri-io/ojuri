import { Decision } from "../enums/decision.enum.js";
import { ReviewOrder } from "../enums/review-order.enum.js";

export interface DecisionAuditRow {
  auditId: string;
  transactionId: string;
  tenantId: string | null;
  senderId: string;
  receiverId: string;
  amount: string | number;
  transactionType: string;
  rawScore: number | null;
  calibratedScore: number | null;
  threshold: number | null;
  finalDecision: string;
  decisionSource: string;
  championModelVersion: string | null;
  shadowModelVersion: string | null;
  ruleId: string | null;
  ruleName: string | null;
  reasonCodes: unknown;
  featureSnapshot: unknown;
  reviewerDecision: string | null;
  reviewerUsername: string | null;
  reviewerReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  [key: string]: unknown;
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
