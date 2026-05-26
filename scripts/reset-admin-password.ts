/**
 * Reset the seeded `admin` user's password.
 *
 * Use when:
 *  - You forgot the password printed by the migration.
 *  - You inherited a deployment whose admin was seeded with an old hash.
 *  - You want to rotate the bootstrap secret without dropping the DB.
 *
 * Usage (from the repo root):
 *
 *   # Generate a random 24-char password, print it once:
 *   npm run reset:admin
 *
 *   # Or pick your own (must be >= 12 chars):
 *   npm run reset:admin -- --password 'my-chosen-secret-string'
 *
 *   # Default targets the user `admin` in tenant `default`. Override:
 *   npm run reset:admin -- --username alice --tenant acme
 *
 * The new password is hashed with bcrypt cost 12 (matches AuthService /
 * the seed migration) and the user row's `mustChangePassword` flag is
 * set to true so the first login forces a rotation.
 *
 * The DB connection is read from .env via the same dotenv path as the
 * migrate command — the friendly "No `.env` file found" message from
 * knexfile.js fires here if you forget that step.
 */

import "dotenv/config";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import knex from "knex";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;
const RANDOM_PASSWORD_BYTES = 18; // 24-char base64url

interface Args {
  username: string;
  tenantId: string;
  password: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { username: "admin", tenantId: "default", password: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--username" && value) {
      out.username = value;
      i++;
    } else if (flag === "--tenant" && value) {
      out.tenantId = value;
      i++;
    } else if (flag === "--password" && value) {
      out.password = value;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: npm run reset:admin -- [--username NAME] [--tenant TENANT] [--password PWD]"
      );
      process.exit(0);
    }
  }
  return out;
}

function resolvePassword(supplied: string | null): { password: string; generated: boolean } {
  if (supplied !== null) {
    if (supplied.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `--password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${supplied.length})`
      );
    }
    return { password: supplied, generated: false };
  }
  return {
    password: randomBytes(RANDOM_PASSWORD_BYTES).toString("base64url"),
    generated: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { password, generated } = resolvePassword(args.password);

  const db = knex({
    client: process.env.DB_CLIENT,
    connection: {
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    },
    pool: { min: 0, max: 2 },
  });

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await db("users")
      .where({ username: args.username, tenantId: args.tenantId })
      .update({
        passwordHash,
        mustChangePassword: true,
        updatedAt: new Date(),
      });

    if (updated === 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\nNo user found with username='${args.username}' tenantId='${args.tenantId}'.\n` +
          `  → Run \`npm run db:migrate\` first if you haven't, or pass --username/--tenant.`
      );
      process.exit(1);
    }

    const line = "═".repeat(78);
    /* eslint-disable no-console */
    console.log(`\n${line}`);
    console.log(`  Password reset for ${args.username}@${args.tenantId}`);
    if (generated) console.log(`  password: ${password}`);
    else console.log(`  password: (the one you passed via --password)`);
    console.log(`  mustChangePassword=true — first login will force a rotation.`);
    console.log(`${line}\n`);
    /* eslint-enable no-console */
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("reset-admin-password failed:", err.message ?? err);
  process.exit(1);
});
