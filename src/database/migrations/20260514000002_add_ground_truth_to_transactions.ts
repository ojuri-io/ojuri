import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Add ground-truth label tracking to `transactions`.
 *
 * Background: `fraudLabel` is set by PAA from the upstream Kafka
 * event — which equals the system's `finalDecision === 'DECLINE'`.
 * Training on that column means the model learns to reproduce its
 * own past decisions, not actual fraud. The feedback loop is the
 * single biggest reason model F1 numbers look fine in development
 * but degrade in production against real chargebacks.
 *
 * `groundTruthFraud` is the column for independently-verified fraud
 * signals: reviewer overrides, chargebacks, customer reports. MLA's
 * training query prefers it when present, falling back to
 * `fraudLabel` for unlabelled rows. The companion columns capture
 * provenance so an audit can answer "where did this label come
 * from?".
 *
 * Both new columns are nullable — they're sparse by design. Most
 * rows never get a ground-truth signal because most transactions
 * are never reviewed or disputed.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.boolean("groundTruthFraud").nullable();
    table.string("groundTruthSource", 32).nullable();
    table.timestamp("groundTruthRecordedAt").nullable();
    table.string("groundTruthRecordedBy", 255).nullable();
  });

  // Partial index covering MLA's preferred training set — rows with
  // a ground-truth label, ordered by recency. Small (only labelled
  // rows) so the query plan stays fast even as `transactions` grows.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_transactions_ground_truth_training
       ON transactions ("createdAt" DESC)
       WHERE "groundTruthFraud" IS NOT NULL`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_transactions_ground_truth_training`);
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.dropColumn("groundTruthRecordedBy");
    table.dropColumn("groundTruthRecordedAt");
    table.dropColumn("groundTruthSource");
    table.dropColumn("groundTruthFraud");
  });
}
