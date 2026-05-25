import { Knex } from "knex";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";
import { SYSTEM_ROLES } from "../../shared/authz/permissions";

/**
 * Auth foundation: users + roles + userRoles join.
 *
 * Permissions are NOT a table — they live in code under
 * `src/shared/authz/permissions.ts`. The role row stores an array of
 * permission code strings. Trade-off: code is the source of truth so a
 * deploy without a migration adds new permissions safely; the price is
 * that we can't `JOIN` against permissions in SQL (we filter in app
 * code). Acceptable for a feature called rarely on admin endpoints.
 *
 * The migration also seeds:
 *   - Three system roles (SUPER_ADMIN, FRAUD_ANALYST, OPERATIONS).
 *   - An `admin` user assigned to SUPER_ADMIN. The bootstrap password
 *     is taken from the `ADMIN_SEED_PASSWORD` env var if set, otherwise
 *     a random 24-char value is generated and printed once to stdout.
 *     Either way `mustChangePassword=true` is set in the next migration
 *     so the first login forces a rotation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DB_TABLES.USERS, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("username", 64).notNullable();
    table.string("passwordHash", 255).notNullable();
    table.string("fullName", 255).nullable();
    table.string("email", 255).nullable();
    table.string("tenantId", 255).notNullable().defaultTo("default");
    table.boolean("isActive").notNullable().defaultTo(true);
    table.timestamp("lastLoginAt").nullable();
    table.string("disabledReason", 255).nullable();

    table.timestamps(true, true, true);

    table.unique(["tenantId", "username"], "uq_users_tenant_username");
    table.index("tenantId", "idx_users_tenant");
  });

  await knex.schema.createTable(DB_TABLES.ROLES, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.string("name", 64).notNullable();
    table.string("description", 512).nullable();
    table.specificType("permissions", "text[]").notNullable().defaultTo("{}");
    table.boolean("isSystem").notNullable().defaultTo(false);
    table.string("tenantId", 255).notNullable().defaultTo("default");

    table.timestamps(true, true, true);

    table.unique(["tenantId", "name"], "uq_roles_tenant_name");
  });

  await knex.schema.createTable(DB_TABLES.USER_ROLES, (table: Knex.TableBuilder) => {
    table.uuid("id").primary().defaultTo(knex.fn.uuid());

    table.uuid("userId").notNullable();
    table.uuid("roleId").notNullable();
    table.timestamp("assignedAt").notNullable().defaultTo(knex.fn.now());
    table.string("assignedBy", 255).nullable();

    table
      .foreign("userId", "fk_user_roles_user")
      .references("id")
      .inTable(DB_TABLES.USERS)
      .onDelete("CASCADE");
    table
      .foreign("roleId", "fk_user_roles_role")
      .references("id")
      .inTable(DB_TABLES.ROLES)
      .onDelete("CASCADE");

    table.unique(["userId", "roleId"], "uq_user_roles");
    table.index("userId", "idx_user_roles_user");
  });

  // ──────── Seed ────────
  const now = new Date();

  const roleRows = SYSTEM_ROLES.map((r) => ({
    name: r.name,
    description: r.description,
    permissions: r.permissions as unknown as string[],
    isSystem: true,
    tenantId: "default",
    createdAt: now,
    updatedAt: now,
  }));
  const inserted = await knex(DB_TABLES.ROLES).insert(roleRows).returning(["id", "name"]);
  const superAdminId = inserted.find((row: { name: string }) => row.name === "SUPER_ADMIN")?.id;
  if (!superAdminId) {
    throw new Error("Seed failed: SUPER_ADMIN row not returned after insert");
  }

  const { password, source } = resolveSeedPassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const [adminUser] = await knex(DB_TABLES.USERS)
    .insert({
      username: "admin",
      passwordHash,
      fullName: "Default Admin",
      tenantId: "default",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning(["id"]);

  await knex(DB_TABLES.USER_ROLES).insert({
    userId: adminUser.id,
    roleId: superAdminId,
    assignedAt: now,
    assignedBy: "migration:seed",
  });

  // When the password was generated (not operator-supplied), print it
  // loudly so it's hard to miss in the migration output. The seeded
  // admin has mustChangePassword=true (next migration) so this value
  // is only good for the first login.
  if (source === "generated") {
    printSeedPasswordBanner(password);
  }
}

const BCRYPT_ROUNDS = 12;

function resolveSeedPassword(): { password: string; source: "env" | "generated" } {
  const fromEnv = process.env.ADMIN_SEED_PASSWORD?.trim();
  if (fromEnv && fromEnv.length >= 12) {
    return { password: fromEnv, source: "env" };
  }
  if (fromEnv && fromEnv.length < 12) {
    throw new Error(
      "ADMIN_SEED_PASSWORD is set but shorter than 12 characters. " +
        "Pick a longer value or unset it to have a random password generated."
    );
  }
  // 24 base64url chars ≈ 18 bytes ≈ 144 bits of entropy. Plenty for a
  // single-use bootstrap secret.
  const random = randomBytes(18).toString("base64url");
  return { password: random, source: "generated" };
}

function printSeedPasswordBanner(password: string): void {
  const line = "═".repeat(78);
  // Use console.log directly — knex's logger swallows stdout from
  // migrations and we genuinely want the operator to see this.
  /* eslint-disable no-console */
  console.log(`\n${line}`);
  console.log("  Ojuri admin user seeded");
  console.log(`  username: admin`);
  console.log(`  password: ${password}`);
  console.log("  This password is shown once and won't be printed again.");
  console.log("  mustChangePassword=true — the first login will force a rotation.");
  console.log("  Set ADMIN_SEED_PASSWORD before re-running migrations to choose your own.");
  console.log(`${line}\n`);
  /* eslint-enable no-console */
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DB_TABLES.USER_ROLES);
  await knex.schema.dropTableIfExists(DB_TABLES.ROLES);
  await knex.schema.dropTableIfExists(DB_TABLES.USERS);
}
