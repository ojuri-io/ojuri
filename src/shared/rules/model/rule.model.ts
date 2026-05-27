import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";
import { RuleExpression } from "../rule.types";

export class Rule extends Model {
  static override tableName = DB_TABLES.RULES;

  static override jsonAttributes = ["expression"];

  id!: string;
  name!: string;
  description!: string | null;
  stage!: string;
  priority!: number;
  action!: string;
  expression!: RuleExpression;
  isActive!: boolean;
  createdBy!: string | null;
  tenantId!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export type IRule = ModelObject<Rule>;
