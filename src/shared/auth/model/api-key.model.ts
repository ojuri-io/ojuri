import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class ApiKey extends Model {
  static tableName = DB_TABLES.API_KEYS;

  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scope: string;
  rateLimitPerMinute: number;
  isActive: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IApiKey = ModelObject<ApiKey>;
