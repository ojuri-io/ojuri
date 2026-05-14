import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Add `decisionSource` and `ruleName` to `transactions` so MLA's
 * training query can exclude rule-driven rows.
 *
 * Why this matters: today `fraudLabel` is `(finalDecision === 'DECLINE')`.
 * If a PRE/POST rule blocked the transaction, that DECLINE leaks into
 * the training set and the next model learns to mimic the rule — a
 * self-reinforcing loop with no ground-truth signal. With `decisionSource`
 * persisted, MLA filters to `decisionSource = 'ML'` and trains only on
 * rows where the model actually made the call.
 *
 * Both columns are nullable so the migration is non-breaking on rows
 * inserted by older PAA builds.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.string("decisionSource", 32).nullable();
    table.string("ruleName", 255).nullable();
  });

  // Partial index covering MLA's read path: only ML-driven labelled
  // rows, ordered by recency. Same shape as `idx_transactions_timestamp`
  // but pre-filtered, so the training-data query doesn't scan
  // rule-driven rows the next iteration of MLA needs to ignore.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_transactions_ml_training
       ON transactions ("createdAt" DESC)
       WHERE "fraudLabel" IS NOT NULL
         AND ("decisionSource" IS NULL OR "decisionSource" = 'ML')`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_transactions_ml_training`);
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.dropColumn("ruleName");
    table.dropColumn("decisionSource");
  });
}
