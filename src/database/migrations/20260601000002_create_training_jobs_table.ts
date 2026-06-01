import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.TRAINING_JOBS, (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("source", 2048).notNullable().unique();
    table.string("status", 16).notNullable().defaultTo("QUEUED");
    table.integer("rowsRead").notNullable().defaultTo(0);
    table.integer("rowsStaged").notNullable().defaultTo(0);
    table.integer("rowsRejected").notNullable().defaultTo(0);
    table.jsonb("errors").nullable();
    table.string("tenantId", 255).nullable();
    table.string("createdBy", 255).notNullable();
    table.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("startedAt", { useTz: true }).nullable();
    table.timestamp("completedAt", { useTz: true }).nullable();
    table.timestamp("updatedAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["status", "createdAt"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DB_TABLES.TRAINING_JOBS);
}
