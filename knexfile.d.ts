import type { Knex } from "knex";

export const config: {
  primary: Knex.Config;
  secondary: Knex.Config;
};
