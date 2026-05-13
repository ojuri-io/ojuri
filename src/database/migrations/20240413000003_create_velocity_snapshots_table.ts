import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.VELOCITY_SNAPSHOTS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("userId", 255).notNullable();
    table.integer("velocity1h").defaultTo(0);
    table.integer("velocity24h").defaultTo(0);
    table.integer("velocity7d").defaultTo(0);
    table.decimal("avgAmount30d", 15, 2).defaultTo(0);
    table.decimal("stdAmount30d", 15, 2).defaultTo(0);
    table.integer("timeSinceLastTxn").defaultTo(0);
    table.timestamp("snapshotAt").defaultTo(knex.fn.now());

    table.timestamps(true, true, true);

    // Indexes
    table.index(["userId", "snapshotAt"], "idx_velocity_user_snapshot");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.VELOCITY_SNAPSHOTS);
}
