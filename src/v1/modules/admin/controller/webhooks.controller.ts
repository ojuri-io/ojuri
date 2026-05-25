import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import WebhookService from "@shared/webhooks/webhook.service";
import WebhookDeliveryRepo from "@shared/webhooks/repositories/webhook-delivery.repo";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { resolveTenantScope } from "@shared/authz/tenant-scope";
import { isWebhookUrlSafe } from "@shared/webhooks/url-guard";
import { RegisterWebhookDto } from "../dtos/webhook.dto";

@injectable()
class WebhooksController {
  constructor(
    private webhookService: WebhookService,
    private deliveryRepo: WebhookDeliveryRepo
  ) {}

  register = async (req: FastifyRequest<{ Body: RegisterWebhookDto }>, res: FastifyReply) => {
    const body = req.body;
    const tenantId = resolveTenantScope(req.auth, body.tenantId);

    const verdict = await isWebhookUrlSafe(body.url);
    if (!verdict.ok) {
      return res
        .code(httpStatus.BAD_REQUEST)
        .send(ErrorResponse(`Webhook URL rejected: ${verdict.reason}`));
    }

    const result = await this.webhookService.register({ ...body, tenantId });
    return res
      .code(httpStatus.CREATED)
      .send(SuccessResponse("Webhook registered — store the secret now.", result));
  };

  list = async (req: FastifyRequest<{ Querystring: { tenantId?: string } }>, res: FastifyReply) => {
    const tenantId = resolveTenantScope(req.auth, req.query.tenantId);
    const rows = await this.webhookService.list(tenantId);
    return res.send(SuccessResponse("Webhook subscriptions", rows));
  };

  revoke = async (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    const ok = await this.webhookService.revoke(req.params.id);
    if (!ok) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Subscription not found"));
    return res.send(SuccessResponse("Subscription revoked"));
  };

  listDeliveries = async (
    req: FastifyRequest<{ Querystring: { limit?: string; status?: string } }>,
    res: FastifyReply
  ) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = await this.deliveryRepo.listRecent({
      limit: Number.isFinite(limit) ? limit : undefined,
      status: req.query.status,
    });
    return res.send(SuccessResponse("Webhook deliveries", rows));
  };
}

export default WebhooksController;
