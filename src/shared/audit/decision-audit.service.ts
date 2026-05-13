import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { ReasonCode } from "@shared/onnx/reason-codes";
import DecisionAuditRepo from "./repositories/decision-audit.repo";
import { DecisionAudit } from "./model/decision-audit.model";

const log = createServiceLogger("DecisionAudit");

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
  shadowScore?: number | null;
  threshold: number;

  mlDecision: "ACCEPT" | "DECLINE";
  finalDecision: "ACCEPT" | "DECLINE" | "REVIEW";
  decisionSource: "ML" | "PRE_RULE" | "POST_RULE";

  ruleId?: string | null;
  ruleName?: string | null;
  ruleStage?: "PRE" | "POST" | null;

  reasonCodes?: ReasonCode[] | null;
  featuresSnapshot?: Record<string, number> | null;
  featuresDefault?: boolean;

  latencyMs: number;
}

@singleton()
class DecisionAuditService {
  constructor(private readonly repo: DecisionAuditRepo) {}

  async record(rec: DecisionAuditRecord): Promise<string | null> {
    try {
      const row = await this.repo.save({
        transactionId: rec.transactionId,
        tenantId: rec.tenantId ?? null,
        apiKeyId: rec.apiKeyId ?? null,
        correlationId: rec.correlationId ?? null,
        idempotencyKey: rec.idempotencyKey ?? null,

        senderId: rec.senderId,
        receiverId: rec.receiverId ?? null,
        amount: rec.amount,
        transactionType: rec.transactionType ?? null,
        segment: rec.segment ?? null,

        championModelVersion: rec.championModelVersion,
        shadowModelVersion: rec.shadowModelVersion ?? null,
        championScore: rec.championScore,
        shadowScore: rec.shadowScore ?? null,
        threshold: rec.threshold,

        mlDecision: rec.mlDecision,
        finalDecision: rec.finalDecision,
        decisionSource: rec.decisionSource,

        ruleId: rec.ruleId ?? null,
        ruleName: rec.ruleName ?? null,
        ruleStage: rec.ruleStage ?? null,

        reasonCodes: rec.reasonCodes ?? null,
        featuresSnapshot: rec.featuresSnapshot ?? null,
        featuresDefault: rec.featuresDefault ?? false,

        latencyMs: rec.latencyMs,
      });

      return row.id;
    } catch (err) {
      // Audit-log failures must never break the decision path.
      log.error("record", "Failed to persist decision audit row", {
        transactionId: rec.transactionId,
        err: String(err),
      });
      return null;
    }
  }

  async override(input: {
    auditId: string;
    reviewer: string;
    decision: "ACCEPT" | "DECLINE";
    reason?: string;
  }): Promise<DecisionAudit | null> {
    const row = await this.repo.applyOverride({
      auditId: input.auditId,
      reviewer: input.reviewer,
      decision: input.decision,
      reason: input.reason ?? null,
    });
    return row ?? null;
  }

  async getByTransactionId(transactionId: string): Promise<DecisionAudit | null> {
    const row = await this.repo.findLatestByTransactionId(transactionId);
    return row ?? null;
  }

  async getById(id: string): Promise<DecisionAudit | null> {
    const row = await this.repo.findById(id);
    return row ?? null;
  }

  async listReviewQueue(opts?: { limit?: number }): Promise<DecisionAudit[]> {
    return this.repo.listReviewQueue(opts?.limit ?? 100);
  }
}

export default DecisionAuditService;
