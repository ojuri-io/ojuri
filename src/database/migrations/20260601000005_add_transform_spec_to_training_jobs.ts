import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRAINING_JOBS, (table) => {
    table.jsonb("transformSpec").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRAINING_JOBS, (table) => {
    table.dropColumn("transformSpec");
  });
}
