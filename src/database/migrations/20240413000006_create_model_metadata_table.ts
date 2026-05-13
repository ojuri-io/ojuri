import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.MODEL_METADATA, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("modelVersion", 100).notNullable();
    table.string("modelPath", 500).notNullable();
    table.string("modelHash", 128).nullable();
    table.float("accuracy").nullable();
    table.float("precisionScore").nullable();
    table.float("recall").nullable();
    table.float("f1Score").nullable();
    table.float("aucRoc").nullable();
    table.float("threshold").defaultTo(0.65);
    table.timestamp("deployedAt").defaultTo(knex.fn.now());
    table.timestamp("retiredAt").nullable();
    table.boolean("isActive").defaultTo(true);
    table.jsonb("metadata").nullable();

    table.timestamps(true, true, true);

    // Index
    table.index("isActive", "idx_model_active");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.MODEL_METADATA);
}
