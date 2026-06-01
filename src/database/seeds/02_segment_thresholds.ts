import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";
import { TransactionType } from "../../shared/enums/transaction-type.enum";
import { SegmentThresholdSeedEntry } from "../types/segment-threshold-seed.types";

// CASH_OUT runs higher because PaySim CASH_OUT was fraud-heavy in
// training; without raising the bar, legit ATM withdrawals see a
// 4-6% false-positive rate.
const DEFAULT_THRESHOLDS: SegmentThresholdSeedEntry[] = [
  { segment: TransactionType.CASH_OUT, threshold: 0.70 },
  { segment: TransactionType.CASH_IN, threshold: 0.50 },
  { segment: TransactionType.TRANSFER, threshold: 0.30 },
  { segment: TransactionType.PAYMENT, threshold: 0.50 },
  { segment: TransactionType.DEBIT, threshold: 0.50 },
];

export async function seed(knex: Knex): Promise<void> {
  const activeModel = await knex(DB_TABLES.MODEL_VERSIONS)
    .where({ status: "ACTIVE" })
    .first("version");
  if (!activeModel) return;

  const modelVersion = activeModel.version as string;
  for (const entry of DEFAULT_THRESHOLDS) {
    await knex(DB_TABLES.SEGMENT_THRESHOLDS)
      .insert({
        segment: entry.segment,
        modelVersion,
        threshold: entry.threshold,
        isActive: true,
      })
      .onConflict(["segment", "modelVersion"])
      .merge({
        threshold: entry.threshold,
        isActive: true,
        updatedAt: knex.fn.now(),
      });
  }
}
