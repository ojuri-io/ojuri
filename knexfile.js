/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */

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
  migrations: {
    directory: "src/database/migrations",
    tableName: "migrations",
  },
  seeds: {
    directory: "src/database/seeds",
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
