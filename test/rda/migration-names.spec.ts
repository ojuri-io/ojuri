import { migrationExtension } from "../../src/database/normalize-migration-names";

/**
 * The extension has to track knexfile.js's own `loadExtensions` rule: the
 * container sets KNEX_MIGRATIONS_DIR and runs compiled JavaScript, a
 * checkout leaves it unset and runs TypeScript. If these two ever disagree,
 * the normalizer rewrites names to something knex then cannot find.
 */
describe("which extension a migrate path records", () => {
  it("is .js when pointed at a compiled directory, as the container is", () => {
    expect(migrationExtension({ KNEX_MIGRATIONS_DIR: "/app/dist/database/migrations" })).toBe(".js");
  });

  it("is .ts from a checkout, where knex loads the sources through ts-node", () => {
    expect(migrationExtension({})).toBe(".ts");
  });

  it("agrees with knexfile, which is what knex actually uses", () => {
    const knexfile = require("../../knexfile.js") as {
      migrations: { loadExtensions: string[] };
    };
    expect(knexfile.migrations.loadExtensions).toEqual([migrationExtension()]);
  });
});
