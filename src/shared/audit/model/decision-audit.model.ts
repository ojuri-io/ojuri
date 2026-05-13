import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";
import { ReasonCode } from "@shared/onnx/reason-codes";

export class DecisionAudit extends Model {
  static tableName = DB_TABLES.DECISION_AUDIT_LOG;

  static jsonAttributes = ["reasonCodes", "featuresSnapshot"];

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
  shadowScore: number | null;
  threshold: number;

  mlDecision: string;
  finalDecision: string;
  decisionSource: string;

  ruleId: string | null;
  ruleName: string | null;
  ruleStage: string | null;

  reasonCodes: ReasonCode[] | null;
  featuresSnapshot: Record<string, number> | null;
  featuresDefault: boolean;

  reviewedBy: string | null;
  reviewedAt: Date | null;
  overrideDecision: string | null;
  overrideReason: string | null;

  latencyMs: number;
  createdAt: Date;
  updatedAt: Date;
}

export type IDecisionAudit = ModelObject<DecisionAudit>;
