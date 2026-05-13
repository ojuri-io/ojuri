import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.MODEL_VERSIONS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("version", 100).notNullable().unique();
    table.string("sourceUri", 1024).notNullable();
    table.string("sha256", 128).nullable();
    table.string("status", 16).notNullable().defaultTo("CANDIDATE");

    table.float("defaultThreshold").notNullable().defaultTo(0.65);
    table.jsonb("metrics").nullable();
    table.jsonb("metadata").nullable();

    table.timestamp("activatedAt").nullable();
    table.timestamp("retiredAt").nullable();

    table.timestamps(true, true, true);

    table.index("status", "idx_model_versions_status");
  });

  await knex.schema.createTable(DB_TABLES.SEGMENT_THRESHOLDS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("segment", 100).notNullable();
    table.string("modelVersion", 100).notNullable();
    table.float("threshold").notNullable();
    table.boolean("isActive").notNullable().defaultTo(true);

    table.timestamps(true, true, true);

    table.unique(["segment", "modelVersion"], { indexName: "uq_segment_model" });
    table.index("isActive", "idx_segment_thresholds_active");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(DB_TABLES.SEGMENT_THRESHOLDS);
  await knex.schema.dropTable(DB_TABLES.MODEL_VERSIONS);
}
