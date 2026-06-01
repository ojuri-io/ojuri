import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";
import { TrainingMode } from "../../shared/enums/training-mode.enum";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.MLA_SETTINGS, (table) => {
    table.string("trainingMode", 16).notNullable().defaultTo(TrainingMode.FRESH);
    table.integer("continuedTreesPerRound").notNullable().defaultTo(50);
  });
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.MLA_SETTINGS}" ADD CONSTRAINT mla_settings_training_mode_chk ` +
      `CHECK ("trainingMode" IN ('FRESH', 'CONTINUED'))`,
  );
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.MLA_SETTINGS}" ADD CONSTRAINT mla_settings_continued_trees_chk ` +
      `CHECK ("continuedTreesPerRound" BETWEEN 10 AND 500)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.MLA_SETTINGS}" DROP CONSTRAINT IF EXISTS mla_settings_continued_trees_chk`,
  );
  await knex.raw(
    `ALTER TABLE "${DB_TABLES.MLA_SETTINGS}" DROP CONSTRAINT IF EXISTS mla_settings_training_mode_chk`,
  );
  await knex.schema.alterTable(DB_TABLES.MLA_SETTINGS, (table) => {
    table.dropColumn("continuedTreesPerRound");
    table.dropColumn("trainingMode");
  });
}
