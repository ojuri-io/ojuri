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
      log.error("create", "Failed", { err: String(err) });
      return res.code(httpStatus.INTERNAL_SERVER_ERROR).send(ErrorResponse("Failed to create rule"));
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
}

export default RulesController;
