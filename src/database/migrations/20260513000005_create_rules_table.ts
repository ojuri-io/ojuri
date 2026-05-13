import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.RULES, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("name", 255).notNullable();
    table.text("description").nullable();
    table.string("stage", 16).notNullable().defaultTo("POST");
    table.integer("priority").notNullable().defaultTo(100);
    table.string("action", 16).notNullable();
    table.jsonb("expression").notNullable();
    table.boolean("isActive").notNullable().defaultTo(true);

    table.string("createdBy", 255).nullable();
    table.string("tenantId", 255).nullable();

    table.timestamps(true, true, true);

    table.index(["isActive", "stage", "priority"], "idx_rules_active_stage");
    table.index("tenantId", "idx_rules_tenant");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.RULES);
}
