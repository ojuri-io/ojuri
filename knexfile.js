/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */

// Fail fast on the most common first-run mistake: running `npm run
// db:migrate` (or any knex command) without a `.env` file. The raw
// knex error ("Required configuration option 'client' is missing") is
// cryptic for someone walking through the README — surface a
// specific message that names the fix.
function assertDbEnv() {
  const required = ["DB_CLIENT", "DB_HOST", "DB_PORT", "DB_DATABASE", "DB_USERNAME"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length === 0) return;

  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  const examplePath = path.join(__dirname, ".env.example");
  const hasEnv = fs.existsSync(envPath);
  const hasExample = fs.existsSync(examplePath);

  let hint;
  if (!hasEnv && hasExample) {
    hint = "  → No `.env` file found. Run `cp .env.example .env` from the repo root and try again.";
  } else if (!hasEnv && !hasExample) {
    hint = "  → No `.env` or `.env.example` found — are you running this from the repo root?";
  } else {
    hint = "  → `.env` exists but is missing the variables above. Compare it against `.env.example`.";
  }

  // eslint-disable-next-line no-console
  console.error(
    `\n[ojuri] Database environment is not configured.\n` +
      `  Missing: ${missing.join(", ")}\n` +
      `${hint}\n`
  );
  process.exit(1);
}

assertDbEnv();

const primary = {
  client: process.env.DB_CLIENT,
  connection: {
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  },
  pool: {
    min: 2,
  },
  // loadExtensions limits which files knex requires from the migrations /
  // seeds directories. The default list includes ".ts", which matches both
  // source .ts files AND tsc-emitted .d.ts declarations (path.extname is
  // ".ts" for both). In the production image dist/ contains .d.ts alongside
  // .js, and knex's CommonJS require chokes on the `export` keyword inside
  // a .d.ts. Force the extension list explicitly — .js for compiled dirs,
  // .ts for source dirs — to skip declarations either way.
  migrations: {
    directory: process.env.KNEX_MIGRATIONS_DIR || "src/database/migrations",
    tableName: "migrations",
    loadExtensions: process.env.KNEX_MIGRATIONS_DIR ? [".js"] : [".ts"],
  },
  seeds: {
    directory: process.env.KNEX_SEEDS_DIR || "src/database/seeds",
    loadExtensions: process.env.KNEX_SEEDS_DIR ? [".js"] : [".ts"],
  },
};

const secondary = {
  client: process.env.DB_CLIENT,
  connection: {
    host: process.env.REPLICA_DB_HOST ?? process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    user: process.env.REPLICA_DB_USERNAME ?? process.env.DB_USERNAME,
    password: process.env.REPLICA_DB_PASSWORD ?? process.env.DB_PASSWORD,
    port: process.env.REPLICA_DB_PORT ?? process.env.DB_PORT,
  },
  pool: {
    min: 2,
  },
};

module.exports = {
  ...primary,
  config: {
    primary,
    secondary,
  },
};
