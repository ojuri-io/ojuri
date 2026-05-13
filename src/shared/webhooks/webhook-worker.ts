import { container } from "tsyringe";
import WebhookService from "./webhook.service";
import { createServiceLogger } from "@shared/utils/logger/service-logger";

const log = createServiceLogger("WebhookWorker");

const WORKER_INTERVAL_MS = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS) || 10_000;

let timer: NodeJS.Timeout | null = null;

export function startWebhookWorker(): void {
  if (timer) return;

  const service = container.resolve(WebhookService);

  timer = setInterval(async () => {
    try {
      const ids = await service.pullDueDeliveries(100);
      if (ids.length > 0) {
        log.debug("tick", "Processing pending webhook deliveries", { count: ids.length });
        await service.processPendingDeliveries(ids);
      }
    } catch (err) {
      log.error("tick", "Webhook worker iteration failed", { err: String(err) });
    }
  }, WORKER_INTERVAL_MS);

  if (timer.unref) timer.unref();
}

export function stopWebhookWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
