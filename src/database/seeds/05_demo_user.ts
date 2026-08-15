import { Knex } from "knex";
import bcrypt from "bcrypt";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";
import {
  DEMO_PERMISSIONS,
  DEMO_ROLE_NAME,
  DEMO_USERNAME,
} from "../../shared/authz/demo-account";

/**
 * Public-demo identity for a throwaway sandbox — a shared account whose
 * credentials are meant to be published, so anyone can sign in, watch their own
 * transaction land in the audit log, and issue themselves an API key.
 *
 * Skipped entirely unless SEED_DEMO_USER=true. It must never appear in a real
 * deployment: a known-credential account on a self-hosted fraud platform is a
 * vulnerability, not a convenience, which is why this is opt-in rather than
 * seeded-then-disabled.
 *
 * The role is read-mostly by construction — see `demo-account.ts`, which also
 * carries the username the sign-in route reports back to the dashboard.
 *
 * Idempotent on username and role name; re-running does not duplicate rows and
 * does not reset a password an operator has changed.
 */

const BCRYPT_ROUNDS = 12;

export async function seed(knex: Knex): Promise<void> {
  if ((process.env.SEED_DEMO_USER ?? "").toLowerCase() !== "true") return;

  const password = process.env.DEMO_USER_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error(
      "SEED_DEMO_USER=true but DEMO_USER_PASSWORD is unset or shorter than 8 characters. " +
        "This password is intended to be published alongside a public sandbox — set it explicitly."
    );
  }

  const now = new Date();

  const existingRole = await knex(DB_TABLES.ROLES).where({ name: DEMO_ROLE_NAME }).first();
  const roleId = existingRole
    ? existingRole.id
    : (
        await knex(DB_TABLES.ROLES)
          .insert({
            name: DEMO_ROLE_NAME,
            description: "Read-mostly public demo access. Cannot alter decisioning or identity.",
            permissions: DEMO_PERMISSIONS,
            isSystem: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning(["id"])
      )[0].id;

  // Kept in step with the list above so that widening the role in code widens
  // an already-seeded sandbox on the next run.
  if (existingRole) {
    await knex(DB_TABLES.ROLES).where({ id: roleId }).update({
      permissions: DEMO_PERMISSIONS,
      updatedAt: now,
    });
  }

  const existingUser = await knex(DB_TABLES.USERS).where({ username: DEMO_USERNAME }).first();
  if (existingUser) return;

  // mustChangePassword stays false on purpose. The credential is shared and
  // published; forcing a rotation would let whoever signs in first lock out
  // everyone after them, and the failure would look like an outage.
  const [user] = await knex(DB_TABLES.USERS)
    .insert({
      username: DEMO_USERNAME,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      fullName: "Public demo",
      isActive: true,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning(["id"]);

  await knex(DB_TABLES.USER_ROLES).insert({
    userId: user.id,
    roleId,
    assignedAt: now,
    assignedBy: "seed:demo-user",
  });

  /* eslint-disable no-console */
  console.log(`\n  Demo user seeded: ${DEMO_USERNAME} (role ${DEMO_ROLE_NAME})`);
  console.log("  Shared, read-mostly, and intended to be public.\n");
  /* eslint-enable no-console */
}
