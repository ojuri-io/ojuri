import { dirname } from "node:path";
import type { Exec, Probe } from "../exec";
import { loadDotenv, type EnvSource } from "../manifest/env";
import { render, type RenderResult } from "../render";
import type { CommandOptions } from "../render/command";
import { parsePs, runCompose, type ContainerState } from "./stack";
import { probeTargets } from "./urls";

export interface StatusDeps {
  exec: Exec;
  probe: Probe;
}

export interface ServiceHealth {
  name: string;
  /** The URL that answered, or the last one tried. */
  url: string;
  status: "up" | "down" | "degraded";
  httpStatus: number | null;
}

export interface StatusResult {
  ok: boolean;
  containers: ContainerState[];
  health: ServiceHealth[];
  errors: string[];
  render: RenderResult;
}

export async function status(
  manifestPath: string,
  options: { outDir?: string; processEnv?: Record<string, string | undefined> },
  deps: StatusDeps
): Promise<StatusResult> {
  const rendered = render(manifestPath, {
    outDir: options.outDir,
    dryRun: true,
    processEnv: options.processEnv,
  });

  if (!rendered.ok || !rendered.plan) {
    return {
      ok: false,
      containers: [],
      health: [],
      errors: ["The manifest did not validate."],
      render: rendered,
    };
  }

  const projectDir = dirname(rendered.manifestPath);
  const commandOptions: CommandOptions = {
    build: false,
    outDir: options.outDir ?? ".ojuri",
    envFile: ".env",
  };

  const ps = runCompose(
    deps.exec,
    rendered.plan,
    commandOptions,
    ["ps", "-a", "--format", "json"],
    projectDir
  );
  const containers = parsePs(ps.stdout);

  const env: EnvSource = {
    dotenv: loadDotenv(`${projectDir}/.env`),
    process: options.processEnv ?? process.env,
  };
  const health = await probeAll(rendered.plan.cfg, env, deps.probe);

  return {
    ok: ps.status === 0,
    containers,
    health,
    errors: ps.status === 0 ? [] : [ps.stderr.trim() || "docker compose ps failed."],
    render: rendered,
  };
}

async function probeAll(
  cfg: RenderResult["plan"] extends null ? never : NonNullable<RenderResult["plan"]>["cfg"],
  env: EnvSource,
  probe: Probe
): Promise<ServiceHealth[]> {
  const results: ServiceHealth[] = [];

  for (const target of probeTargets(cfg, env)) {
    let health: ServiceHealth = {
      name: target.name,
      url: target.urls[0] ?? "",
      status: "down",
      httpStatus: null,
    };

    // First URL that answers wins. NGINX is tried before the direct host
    // port, so the shipped stack is the fast path and a natively-run
    // service is still found.
    for (const url of target.urls) {
      const res = await probe.get(url, 2000);
      if (!res) continue;
      health = {
        name: target.name,
        url,
        status: res.status === 200 ? "up" : "degraded",
        httpStatus: res.status,
      };
      if (res.status === 200) break;
    }

    results.push(health);
  }

  return results;
}

export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];

  lines.push("Containers");
  if (result.errors.length > 0) {
    // An empty list because Compose could not be reached is not the same
    // as an empty list because nothing is running, and reporting the
    // first as the second sends people looking in the wrong place.
    lines.push("  could not ask Compose. See the error below.");
  } else if (result.containers.length === 0) {
    lines.push("  none running.");
  } else {
    for (const container of [...result.containers].sort((a, b) => a.service.localeCompare(b.service))) {
      const detail =
        container.state === "exited" && container.exitCode !== null
          ? `${container.state} (${container.exitCode})`
          : container.health
            ? `${container.state}, ${container.health}`
            : container.state;
      lines.push(`  ${container.service.padEnd(14)}${detail}`);
    }
  }

  lines.push("", "Readiness");
  for (const service of result.health) {
    const mark = service.status === "up" ? "up" : service.status === "degraded" ? "degraded" : "down";
    const code = service.httpStatus === null ? "no answer" : `HTTP ${service.httpStatus}`;
    lines.push(`  ${service.name.padEnd(14)}${mark.padEnd(10)}${code}  ${service.url}`);
  }

  lines.push("");
  return lines.join("\n");
}
