import { dirname } from "node:path";
import type { Exec } from "../exec";
import { render, type RenderResult } from "../render";
import type { CommandOptions } from "../render/command";
import { runCompose } from "./stack";
import { SERVICE } from "../render/compose-base";
import { resolveStack } from "../stack/resolve";
import { ADMIN_PASSWORD_MIN_LENGTH } from "../secrets";

export interface ResetAdminResult {
  ok: boolean;
  lines: string[];
  errors: string[];
  render: RenderResult;
}

/**
 * Runs inside the RDA container, which carries bcrypt, knex and the
 * connection details but not the repository's `scripts/`. Kept in step
 * with `scripts/reset-admin-password.ts`: same table, same columns,
 * same bcrypt cost, and `mustChangePassword` so the next login rotates.
 */
const SCRIPT = `
const bcrypt = require("bcrypt");
const { randomBytes } = require("crypto");
const knex = require("knex");

const password = process.env.OJURI_NEW_PASSWORD || randomBytes(18).toString("base64url");
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

db("users")
  .where({ username: process.env.OJURI_USERNAME, tenantId: process.env.OJURI_TENANT })
  .update({ passwordHash: bcrypt.hashSync(password, 12), mustChangePassword: true, updatedAt: new Date() })
  .then((updated) => {
    if (updated === 0) {
      console.error("NOUSER");
      process.exitCode = 1;
      return;
    }
    console.log(password);
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
`;

export interface ResetAdminOptions {
  username?: string;
  tenant?: string;
  password?: string;
  outDir?: string;
  processEnv?: Record<string, string | undefined>;
}

export function resetAdmin(
  manifestPath: string,
  options: ResetAdminOptions,
  deps: { exec: Exec }
): ResetAdminResult {
  const username = options.username ?? "admin";
  const tenant = options.tenant ?? "default";

  if (options.password !== undefined && options.password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      lines: [],
      errors: [`--password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`],
      render: render(manifestPath, { dryRun: true, processEnv: options.processEnv }),
    };
  }

  const rendered = render(manifestPath, {
    outDir: options.outDir,
    dryRun: true,
    processEnv: options.processEnv,
  });
  if (!rendered.ok || !rendered.plan) {
    return { ok: false, lines: [], errors: ["The manifest did not validate."], render: rendered };
  }

  const outDir = options.outDir ?? ".ojuri";
  const projectDir = dirname(rendered.manifestPath);
  const resolved = resolveStack(projectDir, outDir);
  const commandOptions: CommandOptions = {
    build: false,
    outDir,
    envFile: ".env",
    stackDir: resolved?.stackDir,
    projectName: resolved?.projectName,
  };

  // NODE_PATH because the script is passed inline rather than written
  // into /app, and Node resolves modules from the script's own directory.
  const args = [
    "exec",
    "-T",
    "-e",
    "NODE_PATH=/app/node_modules",
    "-e",
    `OJURI_USERNAME=${username}`,
    "-e",
    `OJURI_TENANT=${tenant}`,
    ...(options.password === undefined ? [] : ["-e", `OJURI_NEW_PASSWORD=${options.password}`]),
    SERVICE.rda,
    "node",
    "-e",
    SCRIPT,
  ];

  const result = runCompose(deps.exec, rendered.plan, commandOptions, args, projectDir);

  if (result.stderr.includes("NOUSER")) {
    return {
      ok: false,
      lines: [],
      render: rendered,
      errors: [
        `No user ${username} in tenant ${tenant}.`,
        "`ojuri status` shows whether the stack is up and the migration has run.",
      ],
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      lines: [],
      render: rendered,
      errors: [
        "Could not reset the password. The stack has to be running, since this",
        "runs inside the RDA container. `ojuri status` shows what is up.",
        "",
        result.stderr.trim() || result.stdout.trim(),
      ],
    };
  }

  const password = result.stdout.trim().split("\n").pop() ?? "";
  return {
    ok: true,
    render: rendered,
    errors: [],
    lines: [
      "",
      `Password reset for ${username}.`,
      "",
      `  username: ${username}`,
      `  password: ${password}`,
      "",
      "You will be asked to change it on first login.",
    ],
  };
}
