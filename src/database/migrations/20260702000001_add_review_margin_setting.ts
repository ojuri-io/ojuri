import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Seed the `review_margin` runtime setting. Scores inside
 * [threshold - margin, threshold) get an ML decision of REVIEW and
 * land in the analyst queue instead of a hard ACCEPT — turning the
 * model's uncertainty band into ground-truth labels. 0 disables the
 * band (pre-1.2.0 binary behaviour), which is the safe default.
 */
export async function up(knex: Knex): Promise<void> {
  await knex(DB_TABLES.RUNTIME_SETTINGS)
    .insert({
      key: "review_margin",
      type: "number",
      value: "0",
      description:
        "Width of the REVIEW band below the decline threshold. Scores in [threshold - margin, threshold) return REVIEW and enter the analyst queue. 0 disables.",
    })
    .onConflict("key")
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex(DB_TABLES.RUNTIME_SETTINGS).where({ key: "review_margin" }).del();
}
