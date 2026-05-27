import { Knex } from "knex";

// The IDEMPOTENCY_KEYS enum entry was removed when the cache moved to
// Redis (see migration 20260527000001). String literal kept inline so
// this historical migration stays self-contained.

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable("idempotencyKeys", (table: Knex.TableBuilder) => {
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
  return knex.schema.dropTable("idempotencyKeys");
}
