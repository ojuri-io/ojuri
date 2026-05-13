import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.INVESTIGATION_CONVERSATIONS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.uuid("reportId").notNullable();
    table.string("transactionId", 255).notNullable();
    table.integer("turnIndex").notNullable();
    table.string("role", 16).notNullable();
    table.text("content").notNullable();

    table.string("llmModelVersion", 100).nullable();
    table.integer("latencyMs").nullable();

    table.timestamps(true, true, true);

    table.unique(["reportId", "turnIndex"], { indexName: "uq_conversation_turn" });
    table.index("reportId", "idx_conversation_report");
    table.index("transactionId", "idx_conversation_transaction");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.INVESTIGATION_CONVERSATIONS);
}
