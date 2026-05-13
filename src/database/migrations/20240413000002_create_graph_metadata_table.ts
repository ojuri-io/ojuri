import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable(DB_TABLES.GRAPH_METADATA, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());
    table.string("userId", 255).notNullable().unique();
    table.float("pagerank").defaultTo(0);
    table.float("clusteringCoefficient").defaultTo(0);
    table.integer("communityId").defaultTo(0);
    table.float("degreeCentrality").defaultTo(0);
    table.integer("inDegree").defaultTo(0);
    table.integer("outDegree").defaultTo(0);
    table.timestamp("firstSeen").nullable();
    table.timestamp("lastSeen").nullable();
    table.integer("transactionCount").defaultTo(0);
    table.decimal("totalAmount", 20, 2).defaultTo(0);

    table.timestamps(true, true, true);

    // Indexes
    table.index("pagerank", "idx_graph_metadata_pagerank");
    table.index("communityId", "idx_graph_metadata_community");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable(DB_TABLES.GRAPH_METADATA);
}
