import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.API_KEYS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("tenantId", 255).notNullable();
    table.string("name", 255).notNullable();
    table.string("keyPrefix", 16).notNullable();
    table.string("keyHash", 128).notNullable();
    table.string("scope", 32).notNullable().defaultTo("predict");

    table.integer("rateLimitPerMinute").notNullable().defaultTo(600);
    table.boolean("isActive").notNullable().defaultTo(true);

    table.timestamp("lastUsedAt").nullable();
    table.timestamp("expiresAt").nullable();
    table.timestamp("revokedAt").nullable();
    table.string("revokedReason", 255).nullable();

    table.timestamps(true, true, true);

    table.unique("keyHash", "uq_api_keys_hash");
    table.index("tenantId", "idx_api_keys_tenant");
    table.index("isActive", "idx_api_keys_active");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.API_KEYS);
}
