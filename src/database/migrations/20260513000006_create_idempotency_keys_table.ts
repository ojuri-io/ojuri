import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.IDEMPOTENCY_KEYS, (table: Knex.TableBuilder) => {
    table.string("key", 255).notNullable();
    table.string("tenantId", 255).notNullable();
    table.string("requestHash", 128).notNullable();
    table.jsonb("response").notNullable();
    table.timestamp("expiresAt").notNullable();

    table.timestamps(true, true, true);

    table.primary(["tenantId", "key"]);
    table.index("expiresAt", "idx_idempotency_expires_at");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.IDEMPOTENCY_KEYS);
}
