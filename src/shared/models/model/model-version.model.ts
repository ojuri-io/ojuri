import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class ModelVersion extends Model {
  static override tableName = DB_TABLES.MODEL_VERSIONS;

  static override jsonAttributes = ["metrics", "metadata"];

  id: string;
  version: string;
  sourceUri: string;
  sha256: string | null;
  status: string;
  defaultThreshold: number;
  metrics: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IModelVersion = ModelObject<ModelVersion>;
