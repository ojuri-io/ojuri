import Knex from "knex";
import { Knex as IKnex } from "knex/types";
import { Model } from "objection";
import { config } from "../../knexfile";

let knexPrimary: IKnex;
let knexSecondary: IKnex;

export default function init() {
  knexPrimary = Knex(config.primary);

  knexSecondary = Knex(config.secondary);

  Model.knex(knexPrimary); // bind models to primary connection
}

export function getKnexInstance(type: "primary" | "secondary") {
  return type === "primary" ? knexPrimary : knexSecondary;
}
