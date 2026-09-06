import { dirname } from "node:path";
import type { Exec } from "../exec";
import { render, type RenderResult } from "../render";
import type { CommandOptions } from "../render/command";
import { runCompose } from "./stack";

export interface DownResult {
  ok: boolean;
  output: string;
  errors: string[];
  render: RenderResult;
}

/**
 * Stop the stack. `--volumes` also deletes the data: Postgres, Redis,
 * Kafka, the Grafana dashboards and the FIA model cache, which is a
 * 7.6 GB re-download next time. The CLI asks before doing that unless
 * told not to.
 */
export function down(
  manifestPath: string,
  options: {
    volumes?: boolean;
    yes?: boolean;
    outDir?: string;
    processEnv?: Record<string, string | undefined>;
  },
  deps: { exec: Exec }
): DownResult {
  const rendered = render(manifestPath, {
    outDir: options.outDir,
    dryRun: true,
    processEnv: options.processEnv,
  });

  if (!rendered.ok || !rendered.plan) {
    return {
      ok: false,
      output: "",
      errors: ["The manifest did not validate."],
      render: rendered,
    };
  }

  if (options.volumes && options.yes !== true) {
    return {
      ok: false,
      output: "",
      render: rendered,
      errors: [
        "--volumes deletes every volume this stack owns: the Postgres data,",
        "the Redis snapshot, the Kafka log, the Grafana dashboards, and the",
        "FIA model cache, which is a 7.6 GB download to rebuild.",
        "",
        "Re-run with --yes to go ahead.",
      ],
    };
  }

  const commandOptions: CommandOptions = {
    build: false,
    outDir: options.outDir ?? ".ojuri",
    envFile: ".env",
  };
  const args = options.volumes ? ["down", "--volumes"] : ["down"];
  const result = runCompose(
    deps.exec,
    rendered.plan,
    commandOptions,
    args,
    dirname(rendered.manifestPath)
  );

  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
    errors: result.status === 0 ? [] : [result.stderr.trim() || "docker compose down failed."],
    render: rendered,
  };
}
