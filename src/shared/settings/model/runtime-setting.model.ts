import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class RuntimeSetting extends Model {
  static override tableName = DB_TABLES.RUNTIME_SETTINGS;

  id!: string;
  key!: string;
  type!: "number" | "bool" | "string" | "json";
  value!: string;
  description!: string | null;
  updatedBy!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type IRuntimeSetting = ModelObject<RuntimeSetting>;
