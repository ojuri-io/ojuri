import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class WebhookSubscription extends Model {
  static override tableName = DB_TABLES.WEBHOOK_SUBSCRIPTIONS;

  id: string;
  tenantId: string;
  url: string;
  secretHash: string;
  events: string[];
  isActive: boolean;
  maxRetries: number;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
}

export type IWebhookSubscription = ModelObject<WebhookSubscription>;
