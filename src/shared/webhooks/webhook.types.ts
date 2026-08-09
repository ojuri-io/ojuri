import { WebhookEvent } from "@shared/enums/webhook-event.enum";

export interface WebhookSubscriptionInput {
  tenantId: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  maxRetries?: number;
  timeoutMs?: number;
}
