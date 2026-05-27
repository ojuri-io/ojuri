import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class Role extends Model {
  static override tableName = DB_TABLES.ROLES;

  id!: string;
  name!: string;
  description!: string | null;
  permissions!: string[];
  isSystem!: boolean;
  tenantId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export type IRole = ModelObject<Role>;
