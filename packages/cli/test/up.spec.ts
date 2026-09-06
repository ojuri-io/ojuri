import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { down } from "../src/commands/down";
import { status } from "../src/commands/status";
import { summary, up } from "../src/commands/up";
import type { Exec, ExecResult, Probe } from "../src/exec";
import { effective, type Manifest } from "../src/manifest/types";

/**
 * There is no Docker daemon in this environment, so `up`, `down` and
 * `status` are driven through the injected Exec and Probe. What that
 * proves is the orchestration: the order of the steps, the waiting, the
 * gates, and what the operator is told. Whether Compose then does the
 * right thing is covered by the render specs and the CI no-op job.
 */
function project(manifest = "version: 1\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "ojuri-up-"));
  writeFileSync(join(dir, "ojuri.yaml"), manifest, "utf8");
  writeFileSync(join(dir, ".env"), "AUTH_JWT_SECRET=" + "a".repeat(40) + "\n", "utf8");
  return dir;
}

interface Recorder {
  exec: Exec;
  calls: string[][];
}

function recorder(handler: (argv: string[], nth: number) => ExecResult): Recorder {
  const calls: string[][] = [];
  return {
    calls,
    exec: {
      run(argv) {
        calls.push(argv);
        return handler(argv, calls.length);
      },
    },
  };
}

const ok: ExecResult = { status: 0, stdout: "", stderr: "" };
const MIGRATED = '[{"Service":"db-migrate","State":"exited","ExitCode":0}]';

function probeReturning(status: number | null): Probe {
  return { get: async () => (status === null ? null : { status, body: "" }) };
}

const noSleep = async () => {};

describe("up", () => {
  it("brings the stack up, waits for the migration, then waits for readiness", async () => {
    const dir = project();
    const rec = recorder((argv) => (argv.includes("ps") ? { ...ok, stdout: MIGRATED } : ok));

    const result = await up(
      join(dir, "ojuri.yaml"),
      { outDir: ".ojuri" },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );

    expect(result.ok).toBe(true);
    // `up -d` first, then the migration poll, then the logs read.
    expect(rec.calls[0]?.slice(-2)).toEqual(["up", "-d"]);
    expect(rec.calls.some((c) => c.includes("ps"))).toBe(true);
    expect(rec.calls.some((c) => c.includes("logs"))).toBe(true);
  });

  it("passes the rendered env file and the overlay to every compose call", async () => {
    const dir = project();
    const rec = recorder((argv) => (argv.includes("ps") ? { ...ok, stdout: MIGRATED } : ok));
    await up(
      join(dir, "ojuri.yaml"),
      { outDir: ".ojuri" },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    for (const call of rec.calls) {
      expect(call).toContain(".ojuri/.env.rendered");
      expect(call).toContain(".ojuri/docker-compose.override.ojuri.yml");
    }
  });

  it("adds --build and drops the GHCR overlay under --build", async () => {
    const dir = project();
    const rec = recorder((argv) => (argv.includes("ps") ? { ...ok, stdout: MIGRATED } : ok));
    await up(
      join(dir, "ojuri.yaml"),
      { build: true, outDir: ".ojuri" },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    expect(rec.calls[0]).toContain("--build");
    expect(rec.calls[0]).not.toContain("docker-compose.ghcr.yml");
  });

  it("refuses an external Postgres without --yes, and starts nothing", async () => {
    const dir = project(
      "version: 1\ndatastores:\n  postgres:\n    mode: external\n    url: postgresql://u@h/d\n"
    );
    const rec = recorder(() => ok);

    const result = await up(
      join(dir, "ojuri.yaml"),
      { outDir: ".ojuri" },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );

    expect(result.ok).toBe(false);
    expect(rec.calls).toEqual([]);
    expect(result.errors.join(" ")).toContain("--yes");
  });

  it("proceeds against an external Postgres once --yes is given", async () => {
    const dir = project(
      "version: 1\ndatastores:\n  postgres:\n    mode: external\n    url: postgresql://u@h/d\n"
    );
    const rec = recorder((argv) => (argv.includes("ps") ? { ...ok, stdout: MIGRATED } : ok));
    const result = await up(
      join(dir, "ojuri.yaml"),
      { yes: true, outDir: ".ojuri" },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    expect(result.ok).toBe(true);
    expect(rec.calls.length).toBeGreaterThan(0);
  });

  it("refuses to start when the manifest does not validate", async () => {
    const dir = project("version: 1\nservices:\n  paa:\n    replicas: 2\n");
    const rec = recorder(() => ok);
    const result = await up(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    expect(result.ok).toBe(false);
    expect(rec.calls).toEqual([]);
  });

  it("reports a failed migration with its logs rather than a bare exit code", async () => {
    const dir = project();
    const rec = recorder((argv) => {
      if (argv.includes("ps")) {
        return { ...ok, stdout: '[{"Service":"db-migrate","State":"exited","ExitCode":1}]' };
      }
      if (argv.includes("logs")) return { ...ok, stdout: "migration failed: relation exists" };
      return ok;
    });

    const result = await up(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("relation exists");
  });

  it("gives up on readiness rather than waiting forever", async () => {
    const dir = project();
    let clock = 0;
    const rec = recorder((argv) => (argv.includes("ps") ? { ...ok, stdout: MIGRATED } : ok));
    const result = await up(
      join(dir, "ojuri.yaml"),
      { timeoutMs: 10 },
      {
        exec: rec.exec,
        probe: probeReturning(503),
        sleep: noSleep,
        now: () => (clock += 5),
      }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("did not become ready");
  });

  it("stops waiting for a migration that never finishes", async () => {
    const dir = project();
    let clock = 0;
    const rec = recorder((argv) =>
      argv.includes("ps") ? { ...ok, stdout: '[{"Service":"db-migrate","State":"running"}]' } : ok
    );
    const result = await up(
      join(dir, "ojuri.yaml"),
      { timeoutMs: 10 },
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep, now: () => (clock += 5) }
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("did not finish in time");
  });

  it("surfaces a compose failure instead of waiting on a stack that never started", async () => {
    const dir = project();
    const rec = recorder(() => ({ status: 1, stdout: "", stderr: "no space left on device" }));
    const result = await up(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(200), sleep: noSleep }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("no space left");
    expect(rec.calls).toHaveLength(1);
  });
});

describe("the summary up prints", () => {
  const cfg = (m: Manifest = { version: 1 }) => effective(m);

  it("leads with the predict URL and a runnable curl", () => {
    const lines = summary(cfg(), { kind: "existing" }).join("\n");
    expect(lines).toContain("http://localhost/v1/predict");
    expect(lines).toContain("curl -X POST");
    expect(lines).toContain('"transaction_type": "TRANSFER"');
  });

  it("uses a fresh transaction_id each time, since a repeat is a 409", () => {
    const first = summary(cfg(), { kind: "existing" }).join("\n");
    const second = summary(cfg(), { kind: "existing" }).join("\n");
    const id = (text: string) => /"transaction_id": "([^"]+)"/.exec(text)?.[1];
    expect(id(first)).not.toBe(id(second));
  });

  it("prints a generated admin password, which is not recoverable later", () => {
    const lines = summary(cfg(), { kind: "generated", password: "hunter2hunter2" }).join("\n");
    expect(lines).toContain("hunter2hunter2");
    expect(lines).toContain("change it on first login");
  });

  it("points at .env when the password came from ADMIN_SEED_PASSWORD", () => {
    const lines = summary(cfg(), { kind: "seeded-from-env" }).join("\n");
    expect(lines).toContain("ADMIN_SEED_PASSWORD");
    expect(lines).toContain("reset:admin");
  });

  it("says the admin is unchanged on an existing database", () => {
    const lines = summary(cfg(), { kind: "existing" }).join("\n");
    expect(lines).toContain("already existed");
    expect(lines).toContain("reset:admin");
  });

  it("shows Sentinel at the NGINX origin and Grafana on its own port", () => {
    const lines = summary(
      cfg({ version: 1, services: { sentinel: { enabled: true } } }),
      { kind: "existing" }
    ).join("\n");
    expect(lines).toContain("Sentinel  http://localhost");
    expect(lines).toContain("Grafana   http://localhost:3001");
  });

  it("explains the two-step key issuance when API keys are required", () => {
    // POST /v1/admin/api-keys is behind denyIfPasswordRotation and the
    // seeded admin has mustChangePassword, so the key cannot be issued
    // with the bootstrap credential. Say so rather than failing silently.
    const lines = summary(
      cfg({ version: 1, auth: { require_api_key: true } }),
      { kind: "existing" }
    ).join("\n");
    expect(lines).toContain("423");
    expect(lines).toContain("/v1/auth/change-password");
    expect(lines).toContain("/v1/admin/api-keys");
    expect(lines).toContain("X-Api-Key");
  });

  it("says nothing about API keys when they are not required", () => {
    const lines = summary(cfg(), { kind: "existing" }).join("\n");
    expect(lines).not.toContain("api-keys");
  });

  it("carries no em-dashes", () => {
    expect(summary(cfg(), { kind: "generated", password: "x" }).join("\n")).not.toContain("—");
  });
});

describe("down", () => {
  it("stops the stack", () => {
    const dir = project();
    const rec = recorder(() => ok);
    const result = down(join(dir, "ojuri.yaml"), {}, { exec: rec.exec });
    expect(result.ok).toBe(true);
    expect(rec.calls[0]?.slice(-1)).toEqual(["down"]);
  });

  it("refuses --volumes without --yes, and deletes nothing", () => {
    const dir = project();
    const rec = recorder(() => ok);
    const result = down(join(dir, "ojuri.yaml"), { volumes: true }, { exec: rec.exec });
    expect(result.ok).toBe(false);
    expect(rec.calls).toEqual([]);
    expect(result.errors.join(" ")).toContain("7.6 GB");
  });

  it("passes --volumes once confirmed", () => {
    const dir = project();
    const rec = recorder(() => ok);
    down(join(dir, "ojuri.yaml"), { volumes: true, yes: true }, { exec: rec.exec });
    expect(rec.calls[0]).toContain("--volumes");
  });
});

describe("status", () => {
  it("lists containers and probes each enabled service", async () => {
    const dir = project();
    const rec = recorder(() => ({
      ...ok,
      stdout: '[{"Service":"rda","State":"running","Health":"healthy"}]',
    }));
    const result = await status(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(200) }
    );
    expect(result.containers[0]?.service).toBe("rda");
    expect(result.health.map((h) => h.name)).toEqual(["rda", "paa"]);
    expect(result.health.every((h) => h.status === "up")).toBe(true);
  });

  it("falls back to the direct port when NGINX does not answer", async () => {
    const dir = project();
    const rec = recorder(() => ok);
    const seen: string[] = [];
    const probe: Probe = {
      async get(url) {
        seen.push(url);
        return url.includes(":3000") ? { status: 200, body: "" } : null;
      },
    };
    const result = await status(join(dir, "ojuri.yaml"), {}, { exec: rec.exec, probe });
    expect(seen[0]).toBe("http://localhost/ready");
    expect(result.health[0]?.url).toBe("http://localhost:3000/readyz");
    expect(result.health[0]?.status).toBe("up");
  });

  it("calls a non-200 degraded rather than down", async () => {
    const dir = project();
    const rec = recorder(() => ok);
    const result = await status(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(503) }
    );
    expect(result.health[0]?.status).toBe("degraded");
    expect(result.health[0]?.httpStatus).toBe(503);
  });

  it("reports down when nothing answers at all", async () => {
    const dir = project();
    const rec = recorder(() => ok);
    const result = await status(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(null) }
    );
    expect(result.health[0]?.status).toBe("down");
    expect(result.health[0]?.httpStatus).toBeNull();
  });

  it("writes nothing: it is a read-only command", async () => {
    const dir = project();
    const rec = recorder(() => ok);
    const result = await status(
      join(dir, "ojuri.yaml"),
      {},
      { exec: rec.exec, probe: probeReturning(200) }
    );
    expect(result.render.written).toEqual([]);
  });
});
