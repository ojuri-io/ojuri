import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class IdempotencyKey extends Model {
  static tableName = DB_TABLES.IDEMPOTENCY_KEYS;

  static idColumn = ["tenantId", "key"];

  static jsonAttributes = ["response"];

  key: string;
  tenantId: string;
  requestHash: string;
  response: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type IIdempotencyKey = ModelObject<IdempotencyKey>;
