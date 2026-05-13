import knex, { Knex } from "knex";
import appConfig from "@config/app.config";
import logger from "@utils/logger";

let knexInstance: Knex | null = null;

export function getKnexInstance(): Knex {
  if (!knexInstance) {
    knexInstance = knex({
      client: appConfig.database.DB_CLIENT,
      connection: appConfig.database.DB_URL,
      pool: {
        min: 2,
        max: 10,
      },
    });

    logger.info("Database connection initialized");
  }
  return knexInstance;
}

export async function closeDatabase(): Promise<void> {
  if (knexInstance) {
    await knexInstance.destroy();
    knexInstance = null;
    logger.info("Database connection closed");
  }
}
