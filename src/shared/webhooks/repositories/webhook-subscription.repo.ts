import { injectable } from "tsyringe";
import { BaseRepository } from "../../repositories/base.repo";
import {
  IWebhookSubscription,
  WebhookSubscription,
} from "../model/webhook-subscription.model";

@injectable()
class WebhookSubscriptionRepo extends BaseRepository<IWebhookSubscription, WebhookSubscription> {
  constructor() {
    super(WebhookSubscription);
  }

  async listAll(tenantId?: string): Promise<Partial<IWebhookSubscription>[]> {
    const query = WebhookSubscription.query()
      .select("id", "tenantId", "url", "events", "isActive", "maxRetries", "timeoutMs", "createdAt")
      .orderBy("createdAt", "desc");
    if (tenantId) query.where({ tenantId });
    return query;
  }

  async findActiveForEvent(event: string, tenantId?: string): Promise<WebhookSubscription[]> {
    const query = WebhookSubscription.query()
      .where({ isActive: true })
      .whereRaw("? = ANY (events)", [event]);
    if (tenantId) query.andWhere({ tenantId });
    return query;
  }

  async deactivate(id: string): Promise<number> {
    return WebhookSubscription.query().where({ id }).patch({ isActive: false });
  }
}

export default WebhookSubscriptionRepo;
