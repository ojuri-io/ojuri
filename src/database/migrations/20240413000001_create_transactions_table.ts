import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.TRANSACTIONS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("transactionId", 255).notNullable().unique();
    table.string("senderId", 255).notNullable();
    table.string("receiverId", 255).notNullable();
    table.decimal("amount", 15, 2).notNullable();
    table.string("transactionType", 50).notNullable();
    table.bigInteger("timestamp").notNullable();
    table.boolean("fraudLabel").nullable();
    table.float("fraudProbability").nullable();
    table.jsonb("deviceFingerprint").nullable();

    table.timestamps(true, true, true);

    // Indexes
    table.index(["senderId", "timestamp"], "idx_transactions_sender_timestamp");
    table.index(["receiverId", "timestamp"], "idx_transactions_receiver_timestamp");
    table.index("timestamp", "idx_transactions_timestamp");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.TRANSACTIONS);
}
