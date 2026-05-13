import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.DEAD_LETTER_QUEUE, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("messageKey", 255).nullable();
    table.jsonb("messageValue").notNullable();
    table.text("errorMessage").nullable();
    table.text("errorStack").nullable();
    table.integer("retryCount").defaultTo(0);
    table.string("topic", 255).nullable();
    table.integer("partition").nullable();
    table.bigInteger("offsetValue").nullable();
    table.timestamp("lastRetryAt").nullable();

    table.timestamps(true, true, true);

    // Indexes
    table.index(["retryCount", "lastRetryAt"], "idx_dlq_retry");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.DEAD_LETTER_QUEUE);
}
