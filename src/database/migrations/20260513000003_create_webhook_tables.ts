import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.WEBHOOK_SUBSCRIPTIONS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("tenantId", 255).notNullable();
    table.string("url", 1024).notNullable();
    table.string("secretHash", 128).notNullable();
    table.specificType("events", "text[]").notNullable();
    table.boolean("isActive").notNullable().defaultTo(true);

    table.integer("maxRetries").notNullable().defaultTo(6);
    table.integer("timeoutMs").notNullable().defaultTo(5000);

    table.timestamps(true, true, true);

    table.index("tenantId", "idx_webhook_sub_tenant");
    table.index("isActive", "idx_webhook_sub_active");
  });

  await knex.schema.createTable(DB_TABLES.WEBHOOK_DELIVERIES, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.uuid("subscriptionId").notNullable();
    table.string("event", 64).notNullable();
    table.jsonb("payload").notNullable();
    table.string("status", 16).notNullable().defaultTo("PENDING");
    table.integer("attempts").notNullable().defaultTo(0);
    table.integer("lastResponseCode").nullable();
    table.text("lastResponseBody").nullable();
    table.timestamp("lastAttemptedAt").nullable();
    table.timestamp("nextAttemptAt").nullable();

    table.timestamps(true, true, true);

    table
      .foreign("subscriptionId")
      .references("id")
      .inTable(DB_TABLES.WEBHOOK_SUBSCRIPTIONS)
      .onDelete("CASCADE");

    table.index("status", "idx_webhook_del_status");
    table.index("nextAttemptAt", "idx_webhook_del_next_attempt");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable(DB_TABLES.WEBHOOK_DELIVERIES);
  await knex.schema.dropTable(DB_TABLES.WEBHOOK_SUBSCRIPTIONS);
}
