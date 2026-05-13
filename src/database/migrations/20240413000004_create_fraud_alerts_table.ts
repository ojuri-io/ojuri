import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.FRAUD_ALERTS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("transactionId", 255).notNullable();
    table.string("alertType", 50).notNullable();
    table.string("severity", 20).notNullable();
    table.float("fraudProbability").notNullable();
    table.jsonb("featuresUsed").nullable();
    table.text("alertMessage").nullable();
    table.string("status", 20).defaultTo("PENDING");
    table.string("reviewedBy", 255).nullable();
    table.timestamp("reviewedAt").nullable();

    table.timestamps(true, true, true);

    // Indexes
    table.index("status", "idx_fraud_alerts_status");
    table.index("severity", "idx_fraud_alerts_severity");

    // Foreign key (optional - can be enabled if transactions table exists)
    // table.foreign("transactionId").references("transactionId").inTable(DB_TABLES.TRANSACTIONS);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.FRAUD_ALERTS);
}
