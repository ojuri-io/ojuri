import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Adds two display-name columns to `transactions`:
 *
 *   - `customerAccountName` / `beneficiaryAccountName` — readable
 *     labels for the sender / receiver chips on Sentinel's
 *     transaction detail page. Account numbers (`senderId` /
 *     `receiverId`) are numeric in most adopter payloads and don't
 *     yield meaningful initials; these strings give the operator a
 *     name to read. Persisted on `transactions` (PAA-populated);
 *     the audit-row LEFT JOIN surfaces them to the UI.
 *
 * Both nullable so legacy rows pre-dating this migration stay valid
 * and adopters who don't supply them keep working.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.string("customerAccountName", 255).nullable();
    table.string("beneficiaryAccountName", 255).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.dropColumn("customerAccountName");
    table.dropColumn("beneficiaryAccountName");
  });
}
