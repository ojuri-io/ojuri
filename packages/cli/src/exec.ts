import { spawnSync } from "node:child_process";

/**
 * Everything that shells out goes through this, so the specs can drive
 * the commands without a Docker daemon to hand.
 */
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Exec {
  run(argv: string[], options?: { cwd?: string; timeoutMs?: number }): ExecResult;
}

export const systemExec: Exec = {
  run(argv, options = {}) {
    const [command, ...args] = argv;
    if (command === undefined) return { status: 1, stdout: "", stderr: "empty command" };

    const result = spawnSync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 600_000,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.error) {
      return { status: 127, stdout: "", stderr: result.error.message };
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

/** Probing an HTTP endpoint, injectable for the same reason. */
export interface Probe {
  get(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null>;
}

export const systemProbe: Probe = {
  async get(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { status: res.status, body: await res.text() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};
