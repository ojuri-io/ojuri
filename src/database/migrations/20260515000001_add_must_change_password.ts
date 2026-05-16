import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

// Flag set whenever the user's password was assigned by someone other
// than the user themselves — seed admins (default credentials), reset
// flows, freshly-created accounts. Login still succeeds but the
// frontend gates everything behind a forced password-change screen
// until the user picks their own secret. Server enforces the same
// gate at the middleware layer (see require-password-rotation.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.USERS, (table) => {
    table.boolean("mustChangePassword").notNullable().defaultTo(false);
  });

  // Existing seeded admin uses the documented `admin@fraudit` password
  // — flip the flag so the very first login forces a rotation. New
  // installs hit this same flag because the seed migration in this
  // batch runs before any login.
  await knex(DB_TABLES.USERS)
    .where({ username: "admin", tenantId: "default" })
    .update({ mustChangePassword: true });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.USERS, (table) => {
    table.dropColumn("mustChangePassword");
  });
}
