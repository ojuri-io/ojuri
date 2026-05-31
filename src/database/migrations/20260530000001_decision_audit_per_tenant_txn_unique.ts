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

  // Dedupe before the unique constraint or the migration fails on any
  // environment where duplicates accumulated under the previous Redis-
  // only idempotency regime — anything older than 24 h or split across
  // API keys. Keep the newest row per (tenantId, transactionId) on the
  // assumption that newer = more accurate (reviewer overrides, rule
  // changes, etc. always land on later rows). The audit log is append-
  // only from the predict path, so we are only ever discarding "old
  // duplicates" — never authoritative information.
  // The (createdAt, id) ordering matters: two duplicate rows inserted
  // in the same statement share a createdAt to-the-microsecond, so a
  // pure `createdAt <` check leaves them tied and the unique constraint
  // still fails. Adding `id` as a tiebreaker guarantees exactly one row
  // survives per (tenantId, transactionId) pair regardless of clock
  // collisions.
  const deletedRows = await knex.raw(
    `DELETE FROM "${DB_TABLES.DECISION_AUDIT_LOG}" a
       USING "${DB_TABLES.DECISION_AUDIT_LOG}" b
      WHERE a."tenantId" = b."tenantId"
        AND a."transactionId" = b."transactionId"
        AND (a."createdAt" < b."createdAt"
             OR (a."createdAt" = b."createdAt" AND a.id < b.id))`
  );
  // `rowCount` shape differs between pg drivers; cast through `unknown`.
  const deleted = (deletedRows as unknown as { rowCount?: number })?.rowCount ?? 0;
  if (deleted > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[migration 20260530000001] Deduped ${deleted} older decisionAuditLog ` +
        `rows before adding the unique constraint. These were duplicate ` +
        `(tenantId, transactionId) pairs from pre-constraint traffic; the ` +
        `newest row per pair has been retained.`
    );
  }

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
