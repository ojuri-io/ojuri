import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.INVESTIGATION_REPORTS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("transactionId", 255).notNullable().unique();
    table.string("senderId", 255).notNullable();
    table.string("receiverId", 255).nullable();
    table.decimal("amount", 15, 2).notNullable();
    table.string("transactionType", 50).nullable();

    table.float("mlFraudProbability").notNullable();
    table.string("mlDecision", 20).notNullable();

    table.string("verdict", 50).notNullable();
    table.float("agentConfidence").notNullable().defaultTo(0);
    table.string("recommendedAction", 50).notNullable();

    table.text("narrative").nullable();
    table.jsonb("keyIndicators").nullable();
    table.jsonb("featuresSnapshot").nullable();

    table.string("llmModelVersion", 100).nullable();
    table.string("promptTemplateVersion", 50).nullable();
    table.integer("generationLatencyMs").nullable();

    table.string("status", 20).notNullable().defaultTo("GENERATED");
    table.string("reviewedBy", 255).nullable();
    table.timestamp("reviewedAt").nullable();
    table.text("reviewerNotes").nullable();

    table.timestamps(true, true, true);

    table.index("verdict", "idx_investigation_reports_verdict");
    table.index("status", "idx_investigation_reports_status");
    table.index("senderId", "idx_investigation_reports_sender");
    table.index("createdAt", "idx_investigation_reports_created_at");
  });

  // Composite partial index for the most common analyst dashboard query:
  // "show me ungenerated/unreviewed reports newest-first". Partial index
  // keeps it small as reports get marked REVIEWED/CLOSED over time.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_investigation_reports_unreviewed
       ON "investigationReports" ("createdAt" DESC)
       WHERE status = 'GENERATED'`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_investigation_reports_unreviewed`);
  return knex.schema.dropTable(DB_TABLES.INVESTIGATION_REPORTS);
}
