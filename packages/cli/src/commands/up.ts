import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Exec, Probe } from "../exec";
import { lookup, type EnvSource } from "../manifest/env";
import { loadDotenv } from "../manifest/env";
import type { EffectiveConfig } from "../manifest/types";
import { render, type RenderResult } from "../render";
import type { CommandOptions } from "../render/command";
import { ENV_FILENAME, SERVICE } from "../render/compose-base";
import { adminOutcome, migrateOutcome, parsePs, runCompose, type AdminOutcome } from "./stack";
import { baseUrl, probeTargets, summaryUrls } from "./urls";
import { init } from "./init";
import { resolveStack } from "../stack/resolve";

export interface UpDeps {
  exec: Exec;
  probe: Probe;
  /** Waits between polls. Injected so specs do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UpOptions {
  build?: boolean;
  /** Skip writing a missing manifest or .env. */
  noBootstrap?: boolean;
  yes?: boolean;
  outDir?: string;
  timeoutMs?: number;
  processEnv?: Record<string, string | undefined>;
}

export interface UpResult {
  ok: boolean;
  lines: string[];
  errors: string[];
  render: RenderResult;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

export async function up(
  manifestPath: string,
  options: UpOptions,
  deps: UpDeps
): Promise<UpResult> {
  const outDir = options.outDir ?? ".ojuri";
  const previousReplicas = previousRdaReplicas(
    join(dirname(resolve(manifestPath)), outDir, ENV_FILENAME)
  );

  const bootstrap = options.noBootstrap === true ? null : bootstrapIfAbsent(manifestPath);
  if (bootstrap && !bootstrap.ok) {
    return { ok: false, lines: [], errors: bootstrap.errors, render: render(manifestPath, {}) };
  }

  const rendered = render(manifestPath, {
    outDir: options.outDir,
    build: options.build,
    processEnv: options.processEnv,
  });

  if (!rendered.ok || !rendered.plan) {
    return { ok: false, lines: [], errors: ["The manifest did not validate."], render: rendered };
  }

  const cfg = rendered.plan.cfg;
  const projectDir = dirname(rendered.manifestPath);

  // db-migrate runs `seed:run` on every boot, which writes to whatever
  // database it is pointed at. Against the adopter's own Postgres that
  // is a change to their data, so it needs saying out loud first.
  if (cfg.postgres.mode === "external" && options.yes !== true) {
    return {
      ok: false,
      render: rendered,
      lines: [],
      errors: [
        "postgres.mode is external, so db-migrate will run migrations and seeds",
        "against your own database rather than a container this command owns.",
        "Migrations are additive and the seeds are written to be idempotent,",
        "but it is still a write to a database Ojuri does not manage.",
        "",
        "Re-run with --yes to go ahead.",
      ],
    };
  }

  const resolved = resolveStack(projectDir, outDir);
  if (!resolved) {
    return {
      ok: false,
      render: rendered,
      lines: [],
      errors: [
        "Could not find docker-compose.yml, and this package carries no bundled stack.",
        "Reinstall @ojuri/cli, or run from a checkout.",
      ],
    };
  }

  const commandOptions: CommandOptions = {
    build: options.build === true,
    outDir,
    envFile: ".env",
    stackDir: resolved.stackDir,
    projectName: resolved.projectName,
  };

  // Pulled as its own streamed step. Left to `up -d` it is a silent
  // multi-gigabyte download on a first run, which reads as a hang and, on a
  // slow line, used to be killed by the captured-output timeout.
  if (!options.build) {
    const pulled = runCompose(deps.exec, rendered.plan, commandOptions, ["pull"], projectDir, {
      stream: true,
    });
    if (pulled.status !== 0) {
      return {
        ok: false,
        render: rendered,
        lines: [],
        errors: [
          "docker compose pull failed, so nothing was started.",
          failureDetail(pulled),
        ],
      };
    }
  }

  const upArgs = options.build ? ["up", "-d", "--build"] : ["up", "-d"];
  const result = runCompose(deps.exec, rendered.plan, commandOptions, upArgs, projectDir, {
    stream: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      render: rendered,
      lines: [],
      errors: [`docker compose up failed:`, failureDetail(result)],
    };
  }

  const migrate = await waitForMigrate(rendered.plan, commandOptions, projectDir, options, deps);
  if (migrate !== "succeeded") {
    const logs = composeLogs(deps.exec, rendered.plan, commandOptions, projectDir);
    return {
      ok: false,
      render: rendered,
      lines: [],
      errors: [
        migrate === "failed"
          ? "db-migrate exited non-zero, so the schema is not ready."
          : "db-migrate did not finish in time.",
        "",
        ...logs.split("\n").slice(-25),
      ],
    };
  }

  const env = {
    dotenv: loadDotenv(`${projectDir}/.env`),
    process: options.processEnv ?? process.env,
  };

  const ready = await waitForReady(cfg, env, options, deps);
  if (!ready) {
    return {
      ok: false,
      render: rendered,
      lines: [],
      errors: [
        `RDA did not become ready at ${summaryUrls(cfg).predict.replace("/v1/predict", "/ready")}.`,
        "`ojuri status` shows what each container is doing.",
      ],
    };
  }

  const logs = composeLogs(deps.exec, rendered.plan, commandOptions, projectDir);
  const admin = bootstrap?.adminPassword
    ? ({ kind: "bootstrapped", password: bootstrap.adminPassword } as const)
    : adminOutcome(logs, lookup(env, "ADMIN_SEED_PASSWORD"));

  const nginxLines =
    previousReplicas !== null && previousReplicas !== cfg.rda.replicas
      ? restartNginx(
          deps.exec,
          rendered.plan,
          commandOptions,
          projectDir,
          previousReplicas,
          cfg.rda.replicas
        )
      : [];

  const preamble = bootstrap ? bootstrap.messages : [];
  return {
    ok: true,
    render: rendered,
    errors: [],
    lines: [...preamble, ...summary(cfg, admin), ...nginxLines],
  };
}

async function waitForMigrate(
  plan: NonNullable<RenderResult["plan"]>,
  commandOptions: CommandOptions,
  projectDir: string,
  options: UpOptions,
  deps: UpDeps
): Promise<"succeeded" | "failed" | "timeout"> {
  const deadline = (deps.now ?? Date.now)() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sleep = deps.sleep ?? defaultSleep;

  for (;;) {
    const ps = runCompose(deps.exec, plan, commandOptions, ["ps", "-a", "--format", "json"], projectDir);
    const outcome = migrateOutcome(parsePs(ps.stdout));
    if (outcome === "succeeded") return "succeeded";
    if (outcome === "failed") return "failed";
    if ((deps.now ?? Date.now)() >= deadline) return "timeout";
    await sleep(POLL_MS);
  }
}

/**
 * Probes every URL `status` would, not just the one public_url implies. An
 * operator who points public_url at a hostname resolved only from outside the
 * box would otherwise wait out the whole timeout against a healthy stack.
 */
async function waitForReady(
  cfg: EffectiveConfig,
  env: EnvSource,
  options: UpOptions,
  deps: UpDeps
): Promise<boolean> {
  const rda = probeTargets(cfg, env).find((target) => target.name === "rda");
  const urls = rda ? rda.urls : [`${baseUrl(cfg)}/ready`];
  const deadline = (deps.now ?? Date.now)() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sleep = deps.sleep ?? defaultSleep;

  for (;;) {
    for (const url of urls) {
      const res = await deps.probe.get(url, 3000);
      if (res && res.status === 200) return true;
    }
    if ((deps.now ?? Date.now)() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

function composeLogs(
  exec: Exec,
  plan: NonNullable<RenderResult["plan"]>,
  commandOptions: CommandOptions,
  projectDir: string
): string {
  const logs = runCompose(
    exec,
    plan,
    commandOptions,
    ["logs", "--no-color", SERVICE.dbMigrate],
    projectDir
  );
  return `${logs.stdout}\n${logs.stderr}`;
}

/** What an operator needs to see once the stack is answering. */
export function summary(cfg: EffectiveConfig, admin: AdminOutcome): string[] {
  const urls = summaryUrls(cfg);
  const lines: string[] = ["", "Ojuri is up.", "", `  Predict   ${urls.predict}`];

  if (urls.sentinel) lines.push(`  Sentinel  ${urls.sentinel}`);
  if (urls.grafana) lines.push(`  Grafana   ${urls.grafana}`);

  lines.push("", "Score a transaction:", "", ...curlExample(cfg).split("\n"));
  lines.push("", ...adminLines(admin));

  if (cfg.requireApiKey) {
    lines.push("", ...apiKeyLines(cfg));
  }

  return lines;
}

function curlExample(cfg: EffectiveConfig): string {
  const urls = summaryUrls(cfg);
  const key = cfg.requireApiKey ? '\n    -H "X-Api-Key: $OJURI_API_KEY" \\' : "";
  return `  curl -X POST ${urls.predict} \\${key}
    -H "Content-Type: application/json" \\
    -d '{
      "transaction_id": "${randomUUID()}",
      "sender_id": "user_a",
      "receiver_id": "user_b",
      "amount": 300.00,
      "transaction_type": "TRANSFER",
      "timestamp": ${Date.now()},
      "is_authenticated": true,
      "device_is_trusted": true,
      "account_age_days": 900
    }'`;
}

function adminLines(admin: AdminOutcome): string[] {
  switch (admin.kind) {
    case "bootstrapped":
      return [
        "Admin password, generated by this command and written to your .env:",
        "",
        `  username: admin`,
        `  password: ${admin.password}`,
        "",
        "You will be asked to change it on first login.",
      ];
    case "generated":
      return [
        "Admin password, printed once by the migration and not recoverable later:",
        "",
        `  username: admin`,
        `  password: ${admin.password}`,
        "",
        "You will be asked to change it on first login.",
      ];
    case "seeded-from-env":
      return [
        "The admin password is the ADMIN_SEED_PASSWORD in your .env, if this run",
        "created the database. On a database that already existed the admin is",
        "unchanged, and `npm run reset:admin` issues a new password.",
      ];
    case "existing":
      return [
        "The database already existed, so the admin account is unchanged.",
        "Lost the password? `npm run reset:admin` issues a new one.",
      ];
    default:
      return [
        "Could not tell from the migration logs whether this run created the",
        "admin account. `docker compose logs db-migrate` has the detail, and",
        "`npm run reset:admin` issues a fresh password either way.",
      ];
  }
}

/**
 * The first API key cannot be issued from here.
 *
 * `POST /v1/admin/api-keys` sits behind `denyIfPasswordRotation`, and
 * the seeded admin carries `mustChangePassword=true`, so a login with
 * the bootstrap credential is refused with 423 until the password is
 * rotated. Rotating it on the operator's behalf would mean this command
 * inventing a password and consuming a deliberate security gate, so it
 * prints the two steps instead.
 */
function apiKeyLines(cfg: EffectiveConfig): string[] {
  const base = summaryUrls(cfg).predict.replace("/v1/predict", "");
  return [
    "auth.require_api_key is true, so /v1/predict will reject callers without",
    "a key. Issuing the first one takes two steps, because the seeded admin",
    "must rotate its password before any admin endpoint will answer:",
    "",
    `  # 1. Log in, then change the password (the admin API returns 423 until you do)`,
    `  curl -X POST ${base}/v1/auth/login \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"username":"admin","password":"<bootstrap password>"}'`,
    "",
    `  curl -X POST ${base}/v1/auth/change-password \\`,
    `    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\`,
    `    -d '{"currentPassword":"<bootstrap>","newPassword":"<new>"}'`,
    "",
    `  # 2. Log in again for a fresh token, then issue the key`,
    `  curl -X POST ${base}/v1/admin/api-keys \\`,
    `    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\`,
    `    -d '{"name":"first-key"}'`,
    "",
    "Sentinel walks the same rotation on first login, if you would rather click.",
  ];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A first run has neither file, and requiring `ojuri init` first would make the
 * install two commands. Nothing is overwritten: `init` refuses an existing
 * manifest or .env, so a second `up` bootstraps nothing.
 */
function bootstrapIfAbsent(manifestPath: string): {
  ok: boolean;
  messages: string[];
  errors: string[];
  adminPassword?: string;
} | null {
  if (existsSync(manifestPath)) return null;

  const result = init({ dir: dirname(resolve(manifestPath)) });
  return {
    ok: result.ok,
    messages: result.ok ? [...result.messages, ""] : [],
    errors: result.errors,
    adminPassword: result.adminPassword,
  };
}



/**
 * nginx resolves the RDA replica addresses once at startup, so a stack that was
 * already running with a different count is left balancing over stale peers.
 */
function restartNginx(
  exec: UpDeps["exec"],
  plan: NonNullable<RenderResult["plan"]>,
  commandOptions: CommandOptions,
  projectDir: string,
  from: number,
  to: number
): string[] {
  const result = runCompose(exec, plan, commandOptions, ["restart", SERVICE.nginx], projectDir);
  if (result.status !== 0) {
    return [
      "",
      `RDA replicas changed from ${from} to ${to}, but restarting nginx failed, so it`,
      "is still balancing over the old addresses. Run `docker compose restart nginx`.",
    ];
  }
  return ["", `Restarted nginx: RDA replicas changed from ${from} to ${to}.`];
}

/**
 * The count the last `up` rendered. Comparing against it is what tells us the
 * operator changed services.rda.replicas, without asking Docker anything.
 */
function previousRdaReplicas(renderedEnvPath: string): number | null {
  if (!existsSync(renderedEnvPath)) return null;
  const raw = loadDotenv(renderedEnvPath)["RDA_REPLICAS"];
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A streamed step has already printed its own diagnosis to the terminal, so
 * there is nothing in the buffers to repeat. Saying so beats an empty line
 * where an error message is expected.
 */
function failureDetail(result: { stdout: string; stderr: string }): string {
  const captured = result.stderr.trim() || result.stdout.trim();
  return captured || "Docker printed the reason above.";
}
