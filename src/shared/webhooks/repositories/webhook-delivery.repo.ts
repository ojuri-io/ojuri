import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { IWebhookDelivery, WebhookDelivery } from "../model/webhook-delivery.model";
import { WebhookSubscription } from "../model/webhook-subscription.model";

export interface DeliveryWithSubscription {
  deliveryId: string;
  payload: Record<string, unknown>;
  attempts: number;
  event: string;
  subscriptionId: string;
  url: string;
  maxRetries: number;
  timeoutMs: number;
  secretHash: string;
}

@injectable()
class WebhookDeliveryRepo extends BaseRepository<IWebhookDelivery, WebhookDelivery> {
  constructor() {
    super(WebhookDelivery);
  }

  /**
   * Insert one queued delivery per subscription. Returns the
   * generated ids in the same order so the caller can immediately
   * dispatch them.
   */
  async enqueue(rows: Array<Pick<IWebhookDelivery, "subscriptionId" | "event" | "payload">>): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await WebhookDelivery.query()
      .insert(
        rows.map((r) => ({
          subscriptionId: r.subscriptionId,
          event: r.event,
          payload: r.payload,
          status: "PENDING",
          nextAttemptAt: new Date(),
        }))
      )
      .returning("id");
    return (inserted as unknown as WebhookDelivery[]).map((row) => row.id);
  }

  async hydrateForDispatch(ids: string[]): Promise<DeliveryWithSubscription[]> {
    if (ids.length === 0) return [];

    const rows = (await WebhookDelivery.query()
      .alias("d")
      .join(`${WebhookSubscription.tableName} as s`, "s.id", "d.subscriptionId")
      .whereIn("d.id", ids)
      .select(
        "d.id as deliveryId",
        "d.payload as payload",
        "d.attempts as attempts",
        "d.event as event",
        "s.id as subscriptionId",
        "s.url as url",
        "s.maxRetries as maxRetries",
        "s.timeoutMs as timeoutMs",
        "s.secretHash as secretHash"
      )) as unknown as DeliveryWithSubscription[];

    return rows;
  }

  async recordAttempt(
    id: string,
    patch: {
      status: string;
      attempts: number;
      lastResponseCode: number | null;
      lastResponseBody: string | null;
      nextAttemptAt: Date | null;
    }
  ): Promise<void> {
    await WebhookDelivery.query().where({ id }).patch({
      status: patch.status,
      attempts: patch.attempts,
      lastResponseCode: patch.lastResponseCode,
      lastResponseBody: patch.lastResponseBody,
      lastAttemptedAt: new Date(),
      nextAttemptAt: patch.nextAttemptAt,
    });
  }

  async pullDue(limit: number): Promise<string[]> {
    const rows = (await WebhookDelivery.query()
      .where({ status: "PENDING" })
      .andWhere("nextAttemptAt", "<=", new Date())
      .limit(limit)
      .select("id")) as unknown as Pick<WebhookDelivery, "id">[];
    return rows.map((r) => r.id);
  }
}

export default WebhookDeliveryRepo;
