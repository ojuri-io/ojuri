import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

// PAA's in-memory graphology instance reconstructs edges only from a
// 30-day / 100k-row replay of `transactions` on boot. Rings whose
// seed edges fall outside that window are forgotten across restarts.
// This table is the durable edge-list: PAA upserts into it
// incrementally on the standard batch flush and hydrates from it on
// boot before replaying any tail of newer transactions.
export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.TRANSACTION_EDGES, (table: Knex.TableBuilder) => {
    table.string("senderId", 255).notNullable();
    table.string("receiverId", 255).notNullable();
    table.integer("weight").notNullable().defaultTo(0);
    table.decimal("totalAmount", 20, 2).notNullable().defaultTo(0);
    table.bigInteger("firstTransaction").notNullable();
    table.bigInteger("lastTransaction").notNullable();
    table.jsonb("transactionTypes").notNullable().defaultTo(knex.raw("'[]'::jsonb"));

    table.timestamps(true, true, true);

    table.primary(["senderId", "receiverId"]);
    table.index("lastTransaction", "idx_transaction_edges_last_txn");
    table.index("senderId", "idx_transaction_edges_sender");
    table.index("receiverId", "idx_transaction_edges_receiver");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.TRANSACTION_EDGES);
}
