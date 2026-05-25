import { createHash, createHmac, randomBytes, randomUUID } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import WebhookSubscriptionRepo from "./repositories/webhook-subscription.repo";
import WebhookDeliveryRepo, { DeliveryWithSubscription } from "./repositories/webhook-delivery.repo";
import { isWebhookUrlSafe } from "./url-guard";

const log = createServiceLogger("WebhookService");

export type WebhookEvent =
  | "decision.created"
  | "decision.overridden"
  | "model.activated"
  | "rule.activated";

export interface WebhookSubscriptionInput {
  tenantId: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

@singleton()
class WebhookService {
  constructor(
    private readonly subscriptionRepo: WebhookSubscriptionRepo,
    private readonly deliveryRepo: WebhookDeliveryRepo
  ) {}

  /**
   * Register a new subscription. If `secret` is omitted, one is
   * generated and returned — the caller must surface it to the
   * client exactly once. Only the hash is stored.
   */
  async register(input: WebhookSubscriptionInput): Promise<{ id: string; secret: string }> {
    const verdict = await isWebhookUrlSafe(input.url);
    if (!verdict.ok) {
      throw new Error(`Webhook URL rejected: ${verdict.reason}`);
    }

    const secret = input.secret ?? `whsec_${randomBytes(24).toString("base64url")}`;
    const secretHash = createHash("sha256").update(secret).digest("hex");

    const row = await this.subscriptionRepo.save({
      tenantId: input.tenantId,
      url: input.url,
      secretHash,
      events: input.events,
      maxRetries: input.maxRetries ?? 6,
      timeoutMs: input.timeoutMs ?? 5000,
      isActive: true,
    });

    log.info("register", "Webhook subscription created", {
      id: row.id,
      tenantId: input.tenantId,
      events: input.events,
    });

    return { id: row.id, secret };
  }

  async list(tenantId?: string) {
    return this.subscriptionRepo.listAll(tenantId);
  }

  async revoke(id: string): Promise<boolean> {
    const n = await this.subscriptionRepo.deactivate(id);
    return n > 0;
  }

  /**
   * Fan out an event to all matching, active subscriptions. Each
   * delivery is enqueued in `webhookDeliveries`, then dispatched
   * fire-and-forget — failed attempts are retried by the delivery
   * worker (`processPendingDeliveries`).
   */
  async publish(
    event: WebhookEvent,
    payload: Record<string, unknown>,
    tenantId?: string
  ): Promise<void> {
    const subs = await this.subscriptionRepo.findActiveForEvent(event, tenantId);
    if (subs.length === 0) return;

    const envelope = { event, data: payload, sent_at: new Date().toISOString() };
    const ids = await this.deliveryRepo.enqueue(
      subs.map((sub) => ({
        subscriptionId: sub.id,
        event,
        payload: envelope,
      }))
    );

    // Fire-and-forget dispatch.
    this.processPendingDeliveries(ids).catch((err) =>
      log.error("publish", "Delivery worker failed", { err: String(err) })
    );
  }

  /**
   * Attempt to deliver the listed pending deliveries. Used both by
   * the inline path inside `publish` and by the retry worker that
   * periodically scans for due retries.
   */
  async processPendingDeliveries(deliveryIds: string[]): Promise<void> {
    if (deliveryIds.length === 0) return;

    const rows = await this.deliveryRepo.hydrateForDispatch(deliveryIds);
    for (const row of rows) {
      await this.deliverOne(row).catch((err) =>
        log.error("processPendingDeliveries", "Delivery error", {
          deliveryId: row.deliveryId,
          err: String(err),
        })
      );
    }
  }

  private async deliverOne(row: DeliveryWithSubscription): Promise<void> {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const deliveryId = randomUUID();

    // The stored value is `sha256(secret)`, so the signer uses the
    // hash, not the original secret. Clients verify with the secret
    // they were given at registration time using the same scheme.
    const signature = createHmac("sha256", row.secretHash)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), row.timeoutMs);

    const attempts = row.attempts + 1;
    let status = "DELIVERED";
    let responseCode: number | null = null;
    let responseBody: string | null = null;

    try {
      // Re-resolve the URL here to defeat DNS-rebinding attacks where a
      // hostname that resolved to a public IP at registration time now
      // resolves to a private one.
      const verdict = await isWebhookUrlSafe(row.url);
      if (!verdict.ok) {
        throw new Error(`Pre-flight URL check failed: ${verdict.reason}`);
      }

      const resp = await fetch(row.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": row.event,
          "X-Webhook-Delivery": deliveryId,
          "X-Webhook-Signature": `t=${timestamp},v1=${signature}`,
        },
        body,
        signal: controller.signal,
        // Never follow redirects — a 3xx Location header would let a
        // subscriber redirect us to an internal target, defeating the
        // pre-flight check.
        redirect: "manual",
      });
      responseCode = resp.status;
      // 3xx with `redirect: "manual"` shows up as opaque; treat as failure.
      if (resp.status >= 300 && resp.status < 400) {
        status = "FAILED";
        responseBody = `redirect refused (status ${resp.status})`;
      } else {
        responseBody = (await resp.text()).slice(0, 1024);
        if (!resp.ok) status = "FAILED";
      }
    } catch (err) {
      status = "FAILED";
      responseBody = (err instanceof Error ? err.message : String(err)).slice(0, 1024);
    } finally {
      clearTimeout(timer);
    }

    let nextAttemptAt: Date | null = null;
    if (status === "FAILED" && attempts < row.maxRetries) {
      status = "PENDING";
      // Exponential backoff: 30 s * 2^(attempts-1), capped at 1 h.
      const delayMs = Math.min(30_000 * Math.pow(2, attempts - 1), 3_600_000);
      nextAttemptAt = new Date(Date.now() + delayMs);
    }

    await this.deliveryRepo.recordAttempt(row.deliveryId, {
      status,
      attempts,
      lastResponseCode: responseCode,
      lastResponseBody: responseBody,
      nextAttemptAt,
    });
  }

  /**
   * Pull pending deliveries that are due. Called by the retry
   * worker; exported separately so tests can drive it directly.
   */
  async pullDueDeliveries(limit = 50): Promise<string[]> {
    return this.deliveryRepo.pullDue(limit);
  }
}

export default WebhookService;
