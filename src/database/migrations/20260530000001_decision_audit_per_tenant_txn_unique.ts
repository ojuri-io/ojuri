import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Enforces "one decision row per (tenant, transaction_id)" at the
 * database level. Until now duplicate POST /v1/predict calls with the
 * same `transaction_id` were only deduped via the Redis idempotency
 * cache, which is bounded by TTL (24 h) and scoped per API key — so
 * cache miss / TTL expiry / different API keys still produced
 * duplicate audit rows visible on the Transactions page.
 *
 * Backfill: any pre-existing NULL `tenantId` collapses to `'default'`
 * (the same fallback the predict controller's `resolveTenantId`
 * already emits when no tenant header is present). After backfill the
 * column is set NOT NULL so the unique constraint can rely on a
 * non-null tuple.
 */
const UNIQUE_NAME = "uq_decision_audit_tenant_txn";

export async function up(knex: Knex): Promise<void> {
  await knex(DB_TABLES.DECISION_AUDIT_LOG)
    .update({ tenantId: "default" })
    .whereNull("tenantId");

  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table) => {
    table.string("tenantId", 255).notNullable().defaultTo("default").alter();
  });

  await knex.raw(
    `ALTER TABLE "${DB_TABLES.DECISION_AUDIT_LOG}"
       ADD CONSTRAINT ${UNIQUE_NAME} UNIQUE ("tenantId", "transactionId")`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.DECISION_AUDIT_LOG}" DROP CONSTRAINT IF EXISTS ${UNIQUE_NAME}`
  );
  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table) => {
    table.string("tenantId", 255).nullable().alter();
  });
}
