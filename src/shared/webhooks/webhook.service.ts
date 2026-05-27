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
   * The returned `secret` is plaintext and only present in this
   * response — only its sha256 hash is persisted. Surface it to the
   * caller exactly once or it's lost.
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

  async publish(
    event: WebhookEvent,
    payload: Record<string, unknown>,
    tenantId?: string
  ): Promise<void> {
    const subs = await this.subscriptionRepo.findActiveForEvent(event, tenantId);
    if (subs.length === 0) return;

    const envelope = { event, data: payload, sent_at: new Date().toISOString() };
    const ids = await this.deliveryRepo.enqueue(
      subs.map((sub) => ({ subscriptionId: sub.id, event, payload: envelope }))
    );

    this.processPendingDeliveries(ids).catch((err) =>
      log.error("publish", "Delivery worker failed", { err: String(err) })
    );
  }

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

    // HMAC key is sha256(secret) — the stored form, not the plaintext.
    // Subscribers run the same hash to verify; the sample in
    // docs/WEBHOOKS.md mirrors this.
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
      // Re-resolve at delivery time — defeats DNS-rebinding where a
      // hostname that was public at registration now points internal.
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
        // `manual` so a 3xx Location can't redirect us to an internal
        // target after the URL guard passed.
        redirect: "manual",
      });
      responseCode = resp.status;
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
      // 30 s × 2^(attempt-1), capped at 1 h.
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

  async pullDueDeliveries(limit = 50): Promise<string[]> {
    return this.deliveryRepo.pullDue(limit);
  }
}

export default WebhookService;
