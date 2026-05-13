import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.DECISION_AUDIT_LOG, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("transactionId", 255).notNullable();
    table.string("tenantId", 255).nullable();
    table.string("apiKeyId", 255).nullable();
    table.string("correlationId", 255).nullable();
    table.string("idempotencyKey", 255).nullable();

    table.string("senderId", 255).notNullable();
    table.string("receiverId", 255).nullable();
    table.decimal("amount", 18, 4).notNullable();
    table.string("transactionType", 50).nullable();
    table.string("segment", 100).nullable();

    table.string("championModelVersion", 100).notNullable();
    table.string("shadowModelVersion", 100).nullable();
    table.float("championScore").notNullable();
    table.float("shadowScore").nullable();
    table.float("threshold").notNullable();

    table.string("mlDecision", 20).notNullable();
    table.string("finalDecision", 20).notNullable();
    table.string("decisionSource", 32).notNullable().defaultTo("ML");

    table.string("ruleId", 255).nullable();
    table.string("ruleName", 255).nullable();
    table.string("ruleStage", 16).nullable();

    table.jsonb("reasonCodes").nullable();
    table.jsonb("featuresSnapshot").nullable();
    table.boolean("featuresDefault").notNullable().defaultTo(false);

    table.string("reviewedBy", 255).nullable();
    table.timestamp("reviewedAt").nullable();
    table.string("overrideDecision", 20).nullable();
    table.text("overrideReason").nullable();

    table.integer("latencyMs").notNullable();
    table.timestamps(true, true, true);

    table.index("transactionId", "idx_decision_audit_transaction");
    table.index("tenantId", "idx_decision_audit_tenant");
    table.index("apiKeyId", "idx_decision_audit_api_key");
    table.index("senderId", "idx_decision_audit_sender");
    table.index("finalDecision", "idx_decision_audit_final_decision");
    table.index("createdAt", "idx_decision_audit_created_at");
  });

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_decision_audit_review_queue
       ON "decisionAuditLog" ("createdAt" DESC)
       WHERE "finalDecision" = 'DECLINE' AND "reviewedAt" IS NULL`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_decision_audit_review_queue`);
  return knex.schema.dropTable(DB_TABLES.DECISION_AUDIT_LOG);
}
