import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import { SuccessResponse } from "@shared/utils/response.util";
import { REASON_CODE_CATALOGUE } from "@shared/onnx/reason-codes";

interface ListQuery {
  from?: string;
  to?: string;
  decision?: string; // comma-separated: "ACCEPT,DECLINE"
  modelVersion?: string;
  reasonCodes?: string; // comma-separated
  search?: string;
  hasFia?: string; // "true" | "false"
  overridden?: string;
  pending?: string;
  tenantId?: string;
  limit?: string;
  offset?: string;
}

const parseBool = (v?: string) =>
  v === "true" || v === "1" || v === "yes" ? true : v === "false" ? false : undefined;
const parseList = (v?: string) => (v ? v.split(",").filter(Boolean) : undefined);
const parseInt10 = (v?: string) => (v ? Number.parseInt(v, 10) : undefined);

/**
 * Read-side controller for the `decisionAuditLog` table. Two routes
 * pin the same underlying filter machinery:
 *
 *   - `/v1/admin/audit` — the analyst-facing audit explorer
 *     (permission: `audit:read`).
 *   - `/v1/transactions` — the operator-facing transactions list
 *     (permission: `audit:read` — every transaction has an audit row,
 *     so they share the same read permission rather than introducing
 *     a separate `transactions:read`).
 */
@injectable()
class AuditController {
  constructor(private readonly audit: DecisionAuditService) {}

  /**
   * Reason-code catalogue. The Audit log filter chip set reads from
   * here on mount so the list of allowed codes stays in sync with
   * what the reason-code explainer actually emits, instead of being
   * a hardcoded list in the React component.
   */
  reasonCodes = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(SuccessResponse("Reason codes", REASON_CODE_CATALOGUE));
  };

  list = async (req: FastifyRequest<{ Querystring: ListQuery }>, res: FastifyReply) => {
    const q = req.query;
    const { rows, total } = await this.audit.listFiltered({
      from: q.from,
      to: q.to,
      decision: parseList(q.decision),
      modelVersion: q.modelVersion,
      reasonCodes: parseList(q.reasonCodes),
      search: q.search,
      hasFia: parseBool(q.hasFia),
      overridden: parseBool(q.overridden),
      pending: parseBool(q.pending),
      tenantId: q.tenantId,
      limit: parseInt10(q.limit),
      offset: parseInt10(q.offset),
    });
    return res.send(
      SuccessResponse("Audit rows", {
        rows: rows.map((r) => ({
          id: r.id,
          transactionId: r.transactionId,
          tenantId: r.tenantId,
          senderId: r.senderId,
          receiverId: r.receiverId,
          amount: Number(r.amount),
          transactionType: r.transactionType,
          segment: r.segment,
          championModelVersion: r.championModelVersion,
          shadowModelVersion: r.shadowModelVersion,
          championScore: r.championScore == null ? null : Number(r.championScore),
          shadowScore: r.shadowScore == null ? null : Number(r.shadowScore),
          threshold: Number(r.threshold),
          mlDecision: r.mlDecision,
          finalDecision: r.finalDecision,
          decisionSource: r.decisionSource,
          ruleId: r.ruleId,
          ruleName: r.ruleName,
          ruleStage: r.ruleStage,
          ruleAction: r.ruleAction,
          ruleExpression: r.ruleExpression,
          reasonCodes: r.reasonCodes,
          reviewedBy: r.reviewedBy,
          reviewedAt: r.reviewedAt,
          overrideDecision: r.overrideDecision,
          overrideReason: r.overrideReason,
          latencyMs: r.latencyMs,
          createdAt: r.createdAt,
        })),
        total,
        limit: parseInt10(q.limit) ?? 50,
        offset: parseInt10(q.offset) ?? 0,
      })
    );
  };
}

export default AuditController;
