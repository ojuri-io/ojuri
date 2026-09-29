import knex from "knex";
import { migrationExtension, normalizeMigrationNames } from "./normalize-migration-names";

/**
 * Entry point for both migrate paths. Reads the same connection fields
 * knexfile.js does, so it needs no configuration of its own.
 */
async function main(): Promise<void> {
  const db = knex({
    client: process.env.DB_CLIENT,
    connection: {
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    },
    pool: { min: 0, max: 2 },
  });

  try {
    const extension = migrationExtension();
    const updated = await normalizeMigrationNames(db, extension);
    if (updated > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[ojuri] Retargeted ${updated} migration names to ${extension}: this database was ` +
          `last migrated by the other build.`
      );
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[ojuri] Could not normalize migration names: ${String(err)}`);
  process.exit(1);
});
