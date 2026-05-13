import { WebhookEvent } from "@shared/webhooks/webhook.service";

export interface RegisterWebhookDto {
  url: string;
  events: WebhookEvent[];
  tenantId?: string;
  secret?: string;
  maxRetries?: number;
  timeoutMs?: number;
}
