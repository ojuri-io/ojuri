import type { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * The isotonic calibrator MLA fits was never applied at serving time, so
 * the thresholds in `segmentThresholds` are tuned against the raw score
 * distribution. This column lets RDA record the calibrated score in
 * parallel (ONNX_CALIBRATION_MODE=observe) so thresholds can be
 * re-derived from real traffic before calibration drives any decision.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table) => {
    table.float("calibratedScore").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.DECISION_AUDIT_LOG, (table) => {
    table.dropColumn("calibratedScore");
  });
}
