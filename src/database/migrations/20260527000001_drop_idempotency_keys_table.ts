import { Knex } from "knex";

// Idempotency cache moved from Postgres to Redis (sub-ms vs ~1–10 ms
// round-trip on the predict hot path). Rows in this table were
// 24 h-TTL by design, so dropping it loses at most one day of replay
// records — acceptable given the trade-off.
//
// The `down` migration re-creates the table empty for symmetry; it
// does NOT recover the data.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("idempotencyKeys");
}

export async function down(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable("idempotencyKeys");
  if (exists) return;
  await knex.schema.createTable("idempotencyKeys", (table) => {
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
