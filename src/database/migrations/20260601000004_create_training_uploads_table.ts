import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.TRAINING_UPLOADS, (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("filename", 255).notNullable();
    table.bigInteger("expectedBytes").notNullable();
    table.string("expectedSha256", 64).nullable();
    table.integer("chunkSize").notNullable();
    table.string("status", 16).notNullable().defaultTo("IN_PROGRESS");
    table.bigInteger("bytesReceived").notNullable().defaultTo(0);
    table.integer("chunksReceived").notNullable().defaultTo(0);
    table.string("tenantId", 255).nullable();
    table.string("createdBy", 255).notNullable();
    table.uuid("jobId").nullable();
    table.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("completedAt", { useTz: true }).nullable();
    table.timestamp("expiresAt", { useTz: true }).notNullable();
    table.index(["status", "expiresAt"]);
    table.foreign("jobId").references("id").inTable(DB_TABLES.TRAINING_JOBS).onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DB_TABLES.TRAINING_UPLOADS);
}
