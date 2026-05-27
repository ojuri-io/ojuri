import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import RulesService from "@shared/rules/rules.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { CreateRuleDto, UpdateRuleDto } from "../dtos/rule.dto";

const log = createServiceLogger("RulesAdminController");

@injectable()
class RulesController {
  constructor(private rulesService: RulesService) {}

  create = async (req: FastifyRequest<{ Body: CreateRuleDto }>, res: FastifyReply) => {
    try {
      const row = await this.rulesService.create(req.body);
      return res.code(httpStatus.CREATED).send(SuccessResponse("Rule created", row));
    } catch (err) {
      // Capture the full error context (message, code, stack, and the
      // sanitized body) so the next 500 in production logs surfaces
      // the actual cause. Common offenders for this endpoint:
      // - Objection rejects unknown column (frontend sends scratch fields)
      // - PG rejects malformed jsonb in `expression`
      // - tenantId / priority arriving as the wrong shape after JSON parse
      const e = err as Error & { code?: string; detail?: string };
      log.error("create", "Failed to create rule", {
        message: e?.message,
        code: e?.code,
        detail: (e as any)?.detail,
        stack: e?.stack,
        bodyKeys: Object.keys(req.body || {}),
      });
      // Surface the underlying message to the client so the UI's
      // toast is actionable. Trim to 300 chars so we don't leak a
      // full SQL stack to end users.
      const safeMessage = (e?.message || "Failed to create rule").slice(0, 300);
      return res
        .code(httpStatus.INTERNAL_SERVER_ERROR)
        .send(ErrorResponse(`Failed to create rule: ${safeMessage}`));
    }
  };

  list = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(SuccessResponse("Rules", await this.rulesService.list()));
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string }; Body: UpdateRuleDto }>,
    res: FastifyReply
  ) => {
    const row = await this.rulesService.update(req.params.id, req.body);
    if (!row) {
      return res
        .code(httpStatus.BAD_REQUEST)
        .send(ErrorResponse("No updatable fields provided or rule not found"));
    }
    return res.send(SuccessResponse("Rule updated", row));
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    const ok = await this.rulesService.delete(req.params.id);
    if (!ok) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Rule not found"));
    return res.send(SuccessResponse("Rule deleted"));
  };

  // Force-reload the in-memory rules cache. The background reloader
  // runs every RULES_RELOAD_INTERVAL_MS (default 30 s); this endpoint
  // exists for the cases where waiting for the tick isn't acceptable —
  // CI smoke that just ran `db:seed`, operators applying an emergency
  // killswitch, or post-incident verification that a disable took
  // effect immediately.
  reload = async (_req: FastifyRequest, res: FastifyReply) => {
    try {
      await this.rulesService.reload();
      const counts = this.rulesService.counts();
      return res.send(SuccessResponse("Rules cache reloaded", counts));
    } catch (err) {
      const e = err as Error & { code?: string };
      log.error("reload", "Failed to reload rules cache", { message: e?.message, code: e?.code });
      return res
        .code(httpStatus.INTERNAL_SERVER_ERROR)
        .send(ErrorResponse(`Failed to reload rules: ${(e?.message || "unknown").slice(0, 300)}`));
    }
  };
}

export default RulesController;
