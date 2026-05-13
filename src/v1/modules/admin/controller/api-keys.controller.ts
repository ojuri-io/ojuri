import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import ApiKeyService from "@shared/auth/api-key.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { IssueApiKeyDto, RevokeApiKeyDto } from "../dtos/api-key.dto";

const log = createServiceLogger("ApiKeysController");

@injectable()
class ApiKeysController {
  constructor(private apiKeyService: ApiKeyService) {}

  issue = async (req: FastifyRequest<{ Body: IssueApiKeyDto }>, res: FastifyReply) => {
    const { tenantId, name, scope, rateLimitPerMinute, expiresAt } = req.body;

    const result = await this.apiKeyService.issue({
      tenantId: tenantId ?? "default",
      name,
      scope,
      rateLimitPerMinute,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    log.info("issue", "API key issued via admin", { id: result.id, tenantId });

    return res
      .code(httpStatus.CREATED)
      .send(
        SuccessResponse(
          "API key issued — surface the token to the user exactly once; only the hash is stored.",
          result
        )
      );
  };

  list = async (req: FastifyRequest<{ Querystring: { tenantId?: string } }>, res: FastifyReply) => {
    const rows = await this.apiKeyService.list(req.query.tenantId);
    return res.send(SuccessResponse("API keys", rows));
  };

  revoke = async (
    req: FastifyRequest<{ Params: { id: string }; Body: RevokeApiKeyDto }>,
    res: FastifyReply
  ) => {
    const ok = await this.apiKeyService.revoke(req.params.id, req.body?.reason);
    if (!ok) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("API key not found"));
    }
    return res.send(SuccessResponse("API key revoked"));
  };
}

export default ApiKeysController;
