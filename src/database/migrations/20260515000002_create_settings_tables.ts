import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

/**
 * Settings + retrain-runs tables.
 *
 * Three new tables, all keyed for fast single-row reads on the hot path
 * (RDA reads `runtimeSettings.fraud_threshold` on every predict; MLA
 * reads `mlaSettings` every drift check):
 *
 *   • `runtimeSettings` — RDA-owned key/value store. Single row today
 *     (`fraud_threshold`), but generic so we don't ship a new migration
 *     each time we surface a new knob. Type-tagged so the UI knows how
 *     to render and validate (number / bool / string / json).
 *   • `mlaSettings` — MLA's drift detector live config. Single-row
 *     table by design (id=1 sentinel) so the UI never has to choose
 *     which row to edit and the consumer always reads the same row.
 *   • `retrainRuns` — append-only log of every retrain attempt
 *     (drift-triggered, manual, initial). Drives the "last retrain"
 *     panel + the run history list on the Settings page.
 *
 * All values are bounded server-side (see the controllers). The DB
 * layer just stores; validation lives in the service so the UI gets
 * the same error message whether the caller is the dashboard or
 * curl. New permissions (`mla:configure`, `settings:write`) are
 * seeded onto SUPER_ADMIN here so a fresh install can use the page
 * without an extra role-edit step.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.RUNTIME_SETTINGS, (table) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("key", 64).notNullable().unique();
    table.string("type", 16).notNullable(); // number | bool | string | json
    table.text("value").notNullable();      // stringified — typed at read time
    table.string("description", 512).nullable();
    table.string("updatedBy", 255).nullable();
    table.timestamps(true, true, true);
  });

  await knex.schema.createTable(DB_TABLES.MLA_SETTINGS, (table) => {
    table.integer("id").primary(); // always 1 — see CHECK below
    table.decimal("driftF1Threshold", 4, 3).notNullable().defaultTo(0.92);
    table.decimal("driftPsiThreshold", 4, 3).notNullable().defaultTo(0.25);
    table.integer("driftWindowSize").notNullable().defaultTo(1000);
    table.boolean("autoRetrainEnabled").notNullable().defaultTo(true);
    table.string("updatedBy", 255).nullable();
    table.timestamps(true, true, true);
  });
  // Singleton guard — only one row allowed.
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.MLA_SETTINGS}" ADD CONSTRAINT mla_settings_singleton CHECK (id = 1)`
  );

  await knex.schema.createTable(DB_TABLES.RETRAIN_RUNS, (table) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("trigger", 32).notNullable(); // drift | manual | initial
    table.string("triggeredBy", 255).nullable();
    table.string("status", 16).notNullable();  // running | succeeded | failed | rejected
    table.jsonb("metrics").nullable();         // post-train F1/AUC + drift_metrics
    table.string("modelVersion", 64).nullable();
    table.text("failureReason").nullable();
    table.timestamp("startedAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("completedAt").nullable();
    table.timestamps(true, true, true);
    table.index(["startedAt"], "idx_retrain_runs_started");
  });

  // Seed the single mlaSettings row with the current env-var defaults.
  await knex(DB_TABLES.MLA_SETTINGS).insert({
    id: 1,
    driftF1Threshold: 0.92,
    driftPsiThreshold: 0.25,
    driftWindowSize: 1000,
    autoRetrainEnabled: true,
  });

  // Seed the global fraud_threshold runtime setting.
  await knex(DB_TABLES.RUNTIME_SETTINGS).insert({
    key: "fraud_threshold",
    type: "number",
    value: "0.65",
    description:
      "Fallback threshold used when neither per-segment nor per-model defaultThreshold is set. Probability ≥ threshold means DECLINE.",
  });

  // Seed two new permissions onto SUPER_ADMIN so a fresh install can
  // use the page without a manual role-edit step. `permissions` is a
  // text[] column, and the seeded SUPER_ADMIN row may already carry
  // the wildcard `*` — which the auth middleware treats as "grant
  // everything" — so we skip the update when wildcard is present.
  const superAdmin = await knex("roles").where({ name: "SUPER_ADMIN" }).first();
  if (superAdmin) {
    const existing: string[] = Array.isArray(superAdmin.permissions)
      ? superAdmin.permissions
      : [];
    if (!existing.includes("*")) {
      const merged = Array.from(new Set([...existing, "settings:write", "mla:configure"]));
      await knex("roles")
        .where({ id: superAdmin.id })
        .update({ permissions: merged });
    }
  }
  // Also seed onto the OPERATIONS role if present (gets the new perms
  // for routine ops without exposing the full SUPER_ADMIN surface).
  const operations = await knex("roles").where({ name: "OPERATIONS" }).first();
  if (operations) {
    const existing: string[] = Array.isArray(operations.permissions)
      ? operations.permissions
      : [];
    if (!existing.includes("*")) {
      const merged = Array.from(new Set([...existing, "settings:write", "mla:configure"]));
      await knex("roles")
        .where({ id: operations.id })
        .update({ permissions: merged });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Strip the seeded permissions from SUPER_ADMIN — leave others alone
  // (operators who manually granted these to other roles know what they
  // want).
  for (const roleName of ["SUPER_ADMIN", "OPERATIONS"]) {
    const role = await knex("roles").where({ name: roleName }).first();
    if (role) {
      const existing: string[] = Array.isArray(role.permissions) ? role.permissions : [];
      if (!existing.includes("*")) {
        const filtered = existing.filter(
          (p) => p !== "settings:write" && p !== "mla:configure"
        );
        await knex("roles").where({ id: role.id }).update({ permissions: filtered });
      }
    }
  }

  await knex.schema.dropTableIfExists(DB_TABLES.RETRAIN_RUNS);
  await knex.raw(
    `ALTER TABLE IF EXISTS "${DB_TABLES.MLA_SETTINGS}" DROP CONSTRAINT IF EXISTS mla_settings_singleton`
  );
  await knex.schema.dropTableIfExists(DB_TABLES.MLA_SETTINGS);
  await knex.schema.dropTableIfExists(DB_TABLES.RUNTIME_SETTINGS);
}
