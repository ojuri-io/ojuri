import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

const UNIQUE_INDEX = "uq_staging_job_txn";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `
    DELETE FROM "${DB_TABLES.TRANSACTIONS_STAGING}" a
    USING "${DB_TABLES.TRANSACTIONS_STAGING}" b
    WHERE a.ctid > b.ctid
      AND a."jobId" = b."jobId"
      AND a."transactionId" = b."transactionId"
    `,
  );

  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS_STAGING, (table) => {
    table.unique(["jobId", "transactionId"], { indexName: UNIQUE_INDEX });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.TRANSACTIONS_STAGING, (table) => {
    table.dropUnique(["jobId", "transactionId"], UNIQUE_INDEX);
  });
}
