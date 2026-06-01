import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRAINING_JOBS, (table) => {
    table.timestamp("promotedAt", { useTz: true }).nullable();
    table.string("promotedBy", 255).nullable();
    table.integer("promotedRows").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRAINING_JOBS, (table) => {
    table.dropColumn("promotedAt");
    table.dropColumn("promotedBy");
    table.dropColumn("promotedRows");
  });
}
