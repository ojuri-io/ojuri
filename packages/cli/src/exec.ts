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

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Inherit stdio so a long step renders its own progress as it happens.
   * `stdout` and `stderr` come back empty, because the output went to the
   * terminal rather than into a buffer.
   */
  stream?: boolean;
}

export interface Exec {
  run(argv: string[], options?: ExecOptions): ExecResult;
}

/** Anything whose output we parse has to finish in a reasonable time. */
const CAPTURED_TIMEOUT_MS = 600_000;

/**
 * Pulling the images is a multi-gigabyte download on a first run, and killing
 * it at ten minutes left an adopter with a failed install and no explanation.
 * A streamed step shows its own progress, so a slow one reads as slow rather
 * than as a hang, and the ceiling is only here to catch a truly wedged daemon.
 */
const STREAMED_TIMEOUT_MS = 3_600_000;

export const systemExec: Exec = {
  run(argv, options = {}) {
    const [command, ...args] = argv;
    if (command === undefined) return { status: 1, stdout: "", stderr: "empty command" };

    const streaming = options.stream === true;
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      timeout:
        options.timeoutMs ?? (streaming ? STREAMED_TIMEOUT_MS : CAPTURED_TIMEOUT_MS),
      stdio: streaming ? "inherit" : undefined,
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
