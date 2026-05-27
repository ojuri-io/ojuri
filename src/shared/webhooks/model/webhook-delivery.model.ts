import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class WebhookDelivery extends Model {
  static tableName = DB_TABLES.WEBHOOK_DELIVERIES;

  static jsonAttributes = ["payload"];

  id!: string;
  subscriptionId!: string;
  event!: string;
  payload!: Record<string, unknown>;
  status!: string;
  attempts!: number;
  lastResponseCode!: number | null;
  lastResponseBody!: string | null;
  lastAttemptedAt!: Date | null;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type IWebhookDelivery = ModelObject<WebhookDelivery>;
