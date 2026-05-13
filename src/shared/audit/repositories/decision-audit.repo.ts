import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { DecisionAudit, IDecisionAudit } from "../model/decision-audit.model";

@injectable()
class DecisionAuditRepo extends BaseRepository<IDecisionAudit, DecisionAudit> {
  constructor() {
    super(DecisionAudit);
  }

  async findLatestByTransactionId(transactionId: string): Promise<DecisionAudit | undefined> {
    return DecisionAudit.query()
      .where({ transactionId })
      .orderBy("createdAt", "desc")
      .first();
  }

  async applyOverride(input: {
    auditId: string;
    reviewer: string;
    decision: string;
    reason: string | null;
  }): Promise<DecisionAudit | undefined> {
    await DecisionAudit.query().where({ id: input.auditId }).patch({
      reviewedBy: input.reviewer,
      reviewedAt: new Date(),
      overrideDecision: input.decision,
      overrideReason: input.reason,
    });
    return DecisionAudit.query().findById(input.auditId);
  }

  async listReviewQueue(limit: number): Promise<DecisionAudit[]> {
    return DecisionAudit.query()
      .where({ finalDecision: "DECLINE" })
      .whereNull("reviewedAt")
      .orderBy("createdAt", "desc")
      .limit(limit);
  }
}

export default DecisionAuditRepo;
