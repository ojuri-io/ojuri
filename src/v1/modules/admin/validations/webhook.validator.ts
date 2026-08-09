import { WebhookEvent } from "@shared/enums/webhook-event.enum";

const SUBSCRIBABLE_EVENTS = Object.values(WebhookEvent).join(",");

export const registerWebhookValidationRules = {
  url: "required|string|min:8|max:1024",
  events: "required|array",
  "events.*": `string|in:${SUBSCRIBABLE_EVENTS}`,
  tenantId: "string|max:255",
  secret: "string|min:16|max:255",
  maxRetries: "numeric|min:0|max:20",
  timeoutMs: "numeric|min:100|max:60000",
};

export const registerWebhookValidationMessages = {
  "url.required": "Webhook URL is required",
  "events.required": "At least one event must be subscribed",
};
