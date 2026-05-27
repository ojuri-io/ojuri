import { injectable } from "tsyringe";
import { BaseRepository } from "../../repositories/base.repo";
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

  /**
   * Recent delivery rows joined with their subscription URL. Used by
   * the admin dashboard. Bounded by `limit` so a busy webhook can't
   * blow up the response — sort by `createdAt DESC` so the freshest
   * attempts surface first.
   */
  async listRecent(opts: { limit?: number; status?: string }): Promise<RecentDelivery[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const query = WebhookDelivery.query()
      .alias("d")
      .join(`${WebhookSubscription.tableName} as s`, "s.id", "d.subscriptionId")
      .orderBy("d.createdAt", "desc")
      .limit(limit)
      .select(
        "d.id as id",
        "d.status as status",
        "d.event as event",
        "d.attempts as attempts",
        "d.lastResponseCode as lastResponseCode",
        "d.lastAttemptedAt as lastAttemptedAt",
        "d.nextAttemptAt as nextAttemptAt",
        "d.createdAt as createdAt",
        "s.url as url",
        "s.maxRetries as maxRetries"
      );
    if (opts.status) query.where("d.status", opts.status);
    return query as unknown as Promise<RecentDelivery[]>;
  }
}

export interface RecentDelivery {
  id: string;
  status: string;
  event: string;
  attempts: number;
  lastResponseCode: number | null;
  lastAttemptedAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  url: string;
  maxRetries: number;
}

export default WebhookDeliveryRepo;
