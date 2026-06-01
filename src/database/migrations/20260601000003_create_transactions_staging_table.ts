import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.TRANSACTIONS_STAGING, (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("jobId").notNullable();
    table.string("transactionId", 255).notNullable();
    table.string("senderId", 255).notNullable();
    table.string("receiverId", 255).notNullable();
    table.decimal("amount", 15, 2).notNullable();
    table.string("transactionType", 50).notNullable();
    table.bigInteger("timestamp").notNullable();
    table.boolean("fraudLabel").nullable();
    table.boolean("groundTruthFraud").nullable();
    table.string("channel", 32).nullable();
    table.string("currency", 8).nullable();
    table.integer("accountAgeDays").nullable();
    table.string("ipCountry", 8).nullable();
    table.string("transactionCountry", 8).nullable();
    table.integer("sessionToTxnSeconds").nullable();
    table.boolean("deviceIsTrusted").nullable();
    table.boolean("isAuthenticated").nullable();
    table.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index("jobId");
    table.foreign("jobId").references("id").inTable(DB_TABLES.TRAINING_JOBS).onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DB_TABLES.TRANSACTIONS_STAGING);
}
