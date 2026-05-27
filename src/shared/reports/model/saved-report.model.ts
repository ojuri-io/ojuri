import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class SavedReport extends Model {
  static override tableName = DB_TABLES.SAVED_REPORTS;

  static override jsonAttributes = ["filters", "columns"];

  id!: string;
  name!: string;
  description!: string | null;
  dataSource!: string;
  filters!: Record<string, unknown>;
  columns!: string[];
  createdBy!: string | null;
  tenantId!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type ISavedReport = ModelObject<SavedReport>;
