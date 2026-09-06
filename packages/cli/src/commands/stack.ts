import type { Exec } from "../exec";
import { composeCommand, type CommandOptions } from "../render/command";
import { SERVICE } from "../render/compose-base";
import type { RenderPlan } from "../render/plan";

/**
 * Driving `docker compose` for a rendered plan. Every invocation is
 * built by `composeCommand`, so what `up` runs is exactly what
 * `render --print-command` printed.
 */
export interface ContainerState {
  service: string;
  state: string;
  exitCode: number | null;
  health: string | null;
}

export function composeArgs(plan: RenderPlan, opts: CommandOptions, args: string[]): string[] {
  return composeCommand(plan, { ...opts, args });
}

/**
 * `docker compose ps` in JSON. Compose emits either one JSON array or a
 * stream of one object per line, depending on the version, so both are
 * handled.
 */
export function parsePs(stdout: string): ContainerState[] {
  const text = stdout.trim();
  if (text === "") return [];

  const rows: unknown[] = [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {
      return [];
    }
  } else {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A non-JSON line is Compose noise, not a container.
      }
    }
  }

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      service: String(r.Service ?? r.Name ?? ""),
      state: String(r.State ?? ""),
      exitCode: typeof r.ExitCode === "number" ? r.ExitCode : null,
      health: r.Health === undefined || r.Health === "" ? null : String(r.Health),
    };
  });
}

export type MigrateOutcome = "pending" | "succeeded" | "failed";

/**
 * db-migrate is a one-shot: it runs the migrations and seeds, then
 * exits. Waiting for it means waiting for a clean exit, not for a
 * healthy container, so nothing here polls an endpoint.
 */
export function migrateOutcome(states: ContainerState[]): MigrateOutcome {
  const row = states.find((s) => s.service === SERVICE.dbMigrate);
  if (!row) return "pending";
  if (row.state !== "exited") return "pending";
  return row.exitCode === 0 ? "succeeded" : "failed";
}

export function runCompose(
  exec: Exec,
  plan: RenderPlan,
  opts: CommandOptions,
  args: string[],
  cwd: string
): { status: number; stdout: string; stderr: string } {
  return exec.run(composeArgs(plan, opts, args), { cwd });
}

/**
 * What the db-migrate logs say about the admin account.
 *
 * The admin user is created inside a migration, not a seed, so it
 * happens once per database. The migration prints a banner only when it
 * generated the password itself; when ADMIN_SEED_PASSWORD was supplied
 * it prints nothing, and on an existing database it does not run at all.
 * Those three cases need different advice, and guessing wrong sends an
 * operator hunting for a password that was never printed.
 */
export type AdminOutcome =
  | { kind: "generated"; password: string }
  | { kind: "seeded-from-env" }
  | { kind: "existing" }
  | { kind: "unknown" };

export function adminOutcome(logs: string, adminSeedPassword: string | undefined): AdminOutcome {
  const banner = /password:\s*(\S+)/.exec(logs);
  if (logs.includes("Ojuri admin user seeded") && banner?.[1]) {
    return { kind: "generated", password: banner[1] };
  }
  // Knex says this when every migration was already applied, which means
  // the users migration did not run and the admin predates this boot.
  if (/already up to date/i.test(logs)) return { kind: "existing" };
  if (adminSeedPassword && adminSeedPassword.trim() !== "") return { kind: "seeded-from-env" };
  return { kind: "unknown" };
}
