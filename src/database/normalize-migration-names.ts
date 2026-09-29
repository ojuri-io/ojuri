import type { Knex } from "knex";

const MIGRATIONS_TABLE = "migrations";

/** The extension knex will record on this path, matching knexfile's loadExtensions. */
export function migrationExtension(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNEX_MIGRATIONS_DIR ? ".js" : ".ts";
}

/**
 * Rewrites recorded migration names to the extension this path uses.
 *
 * knex records whichever filename it loaded, and the two supported paths
 * load different ones: the container runs compiled JavaScript from dist, a
 * checkout runs TypeScript from src through ts-node. Whichever ran first,
 * the other then finds every completed migration missing from its own
 * directory listing and refuses to run with "the migration directory is
 * corrupt", naming every file. Nothing is corrupt.
 *
 * Runs before migrate:latest on both paths. Idempotent, and a no-op on a
 * database that has never been migrated.
 */
export async function normalizeMigrationNames(
  db: Knex,
  extension: string = migrationExtension()
): Promise<number> {
  if (!(await db.schema.hasTable(MIGRATIONS_TABLE))) return 0;

  return db(MIGRATIONS_TABLE)
    .whereRaw("name ~ '\\.(js|ts)$'")
    .andWhere("name", "not like", `%${extension}`)
    .update({ name: db.raw("regexp_replace(name, '\\.(js|ts)$', ?)", [extension]) });
}
