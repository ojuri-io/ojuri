import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

// Saved reports — operator-defined views over an existing data source
// (currently `audit` → decisionAuditLog). `filters` is the same filter
// shape the audit list endpoint already accepts; `columns` is the
// ordered list of fields to include in CSV/JSON exports. Wider data
// sources (queue, investigations, deliveries) plug into the same row
// shape by switching `dataSource` and validating filters on the run
// path — no schema change required.
export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.SAVED_REPORTS, (table) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("name", 255).notNullable();
    table.text("description").nullable();
    table.string("dataSource", 32).notNullable().defaultTo("audit");

    table.jsonb("filters").notNullable().defaultTo("{}");
    table.jsonb("columns").notNullable().defaultTo("[]");

    table.string("createdBy", 255).nullable();
    table.string("tenantId", 255).nullable();

    table.timestamps(true, true, true);

    table.index("tenantId", "idx_saved_reports_tenant");
    table.index("dataSource", "idx_saved_reports_source");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.SAVED_REPORTS);
}
