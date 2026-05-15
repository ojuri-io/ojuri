import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Promote the optional `/v1/predict` body fields to first-class
 * `transactions` columns so MLA can train on them.
 *
 * Before this migration, RDA's feature builder consumed ~30 optional
 * DTO fields at inference time (customer nationality, channel, FI,
 * country, device type, …) but only nine of them survived the trip
 * to Postgres. The training query then fell back to the catalogue
 * default for everything else — silent gap between what the model
 * sees at predict-time and what it sees at retrain.
 *
 * Design choices:
 *
 *   • **First-class columns, not a single jsonb.** Catalogue features
 *     map 1:1 to columns; the training query stays plain SQL and
 *     adopters can index whatever they query against. JSONB was
 *     tempting for forward-compat but every read would need
 *     `->>` casting and the analytics story is worse.
 *   • **ID numbers are deliberately not persisted.** The catalogue
 *     only uses presence (`has_kyc_id`) and the type code
 *     (`id_type_code`) — the number itself is PII with no model
 *     signal. We persist `customerIdType` / `recipientIdType` but
 *     not the corresponding `_number` fields.
 *   • **All nullable.** They are all optional in the DTO and old
 *     transactions pre-dating this migration will have NULLs the
 *     loader treats as catalogue defaults.
 *   • **No indexes on this migration.** Adopters who query by these
 *     columns (e.g. fraud rate by `transactionCountry`) should add
 *     their own indexes in a follow-up migration.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    // ── Identity ────────────────────────────────────────────────
    table.date("customerDob").nullable();
    table.string("customerNationality", 8).nullable(); // ISO-3166 alpha-2
    table.string("customerType", 32).nullable();        // INDIVIDUAL | CORPORATE
    table.string("customerIdType", 32).nullable();      // BVN | NIN | PASSPORT | …
    table.integer("accountAgeDays").nullable();
    table.boolean("isAuthenticated").nullable();

    // ── Channel + currency ──────────────────────────────────────
    table.string("channel", 32).nullable();             // USSD | MOBILE | WEB | AGENT
    table.string("currency", 8).nullable();             // ISO-4217 alpha-3
    table.boolean("isInflow").nullable();
    table.boolean("isRecurring").nullable();

    // ── Wallet ──────────────────────────────────────────────────
    table.decimal("walletBalance", 15, 2).nullable();

    // ── Geographic ──────────────────────────────────────────────
    table.decimal("customerLatitude", 9, 6).nullable();
    table.decimal("customerLongitude", 9, 6).nullable();
    table.string("transactionCountry", 8).nullable();
    table.string("destinationCountry", 8).nullable();
    table.string("ipCountry", 8).nullable();
    table.decimal("transactionLat", 9, 6).nullable();
    table.decimal("transactionLng", 9, 6).nullable();

    // ── Device / session ────────────────────────────────────────
    table.boolean("ipIsVpn").nullable();
    table.boolean("deviceIsTrusted").nullable();
    table.string("deviceType", 32).nullable();
    table.integer("sessionToTxnSeconds").nullable();

    // ── Agent (mobile-money) ────────────────────────────────────
    // Only `agentId` survives the persistence cut. Agent lat/lng and
    // battery level were dropped on review (2026-05-15): the
    // distance-to-agent signal is ~0 in practice (agent banking is
    // physically present) and battery level is a "weak urgency signal"
    // that the rest of the velocity / off-hours features already cover
    // more robustly. The catalogue still computes `is_agent_assisted`
    // from `agentId` — that one IS useful (agent-channel fraud rates
    // are distinct from web/mobile).
    table.string("agentId", 64).nullable();

    // ── Receiver ────────────────────────────────────────────────
    // `recipientDob` removed on review — recipient age has minimal
    // signal for sender-side fraud. Recipient identity is captured by
    // FI on-us flag, nationality-match, and KYC-presence (id type).
    table.string("recipientNationality", 8).nullable();
    table.string("recipientIdType", 32).nullable();
    table.string("customerFi", 64).nullable();           // sender's FI
    table.string("recipientFi", 64).nullable();          // receiver's FI

    // ── Adopter overflow ────────────────────────────────────────
    // Free-form jsonb for any extra context the adopter wants the
    // model to train on but doesn't want to add a column for. The
    // code-based custom-feature hook reads from this slot at both
    // predict-time and train-time, so values land in the same place
    // whether they came in via a single API call or were backfilled
    // from a warehouse. Keep payloads small (<4 KB) — Postgres jsonb
    // is fine with large blobs but the audit log gets noisy.
    table.jsonb("requestContext").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS, (table) => {
    table.dropColumn("requestContext");
    table.dropColumn("recipientFi");
    table.dropColumn("customerFi");
    table.dropColumn("recipientIdType");
    table.dropColumn("recipientNationality");
    table.dropColumn("agentId");
    table.dropColumn("sessionToTxnSeconds");
    table.dropColumn("deviceType");
    table.dropColumn("deviceIsTrusted");
    table.dropColumn("ipIsVpn");
    table.dropColumn("transactionLng");
    table.dropColumn("transactionLat");
    table.dropColumn("ipCountry");
    table.dropColumn("destinationCountry");
    table.dropColumn("transactionCountry");
    table.dropColumn("customerLongitude");
    table.dropColumn("customerLatitude");
    table.dropColumn("walletBalance");
    table.dropColumn("isRecurring");
    table.dropColumn("isInflow");
    table.dropColumn("currency");
    table.dropColumn("channel");
    table.dropColumn("isAuthenticated");
    table.dropColumn("accountAgeDays");
    table.dropColumn("customerIdType");
    table.dropColumn("customerType");
    table.dropColumn("customerNationality");
    table.dropColumn("customerDob");
  });
}
