import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

// Snapshot rule body + action at decision time. Rules are mutable; without
// the snapshot, the audit row would reflect the rule's current state, not
// what fired.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table: Knex.TableBuilder) => {
    table.jsonb("ruleExpression").nullable();
    table.string("ruleAction", 32).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table: Knex.TableBuilder) => {
    table.dropColumn("ruleAction");
    table.dropColumn("ruleExpression");
  });
}
