import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, VERSION } from "../src/cli";
import type { JsonReport } from "../src/findings";
import { EMPTY_ENV, fixture } from "./helpers";

function capture(argv: string[], env: Record<string, string | undefined> = EMPTY_ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("exit codes", () => {
  it("exits 0 when only warnings are present", () => {
    const { code } = capture(["validate", fixture("default.yaml")]);
    expect(code).toBe(0);
  });

  it("exits 0 on a manifest with nothing to report", () => {
    const { code } = capture(["validate", fixture("hardened.yaml")]);
    expect(code).toBe(0);
  });

  it("exits 1 on any error", () => {
    const { code } = capture(["validate", fixture("paa-scaled.yaml")]);
    expect(code).toBe(1);
  });

  it("exits 1 on a missing manifest", () => {
    const { code } = capture(["validate", fixture("nope.yaml")]);
    expect(code).toBe(1);
  });
});

describe("output", () => {
  it("prints the manifest path and a count", () => {
    const { out } = capture(["validate", fixture("default.yaml")]);
    expect(out).toContain(fixture("default.yaml"));
    expect(out).toContain("0 errors, 3 warnings.");
  });

  it("says so plainly when there is nothing to report", () => {
    const { out } = capture(["validate", fixture("hardened.yaml")]);
    expect(out).toContain("No problems found.");
  });

  it("puts errors before warnings", () => {
    const { out } = capture(["validate", fixture("paa-scaled.yaml")]);
    expect(out.indexOf("error")).toBeLessThan(out.indexOf("warning"));
  });

  it("uses a singular count for one finding", () => {
    const { out } = capture(["validate", fixture("sentinel-no-fia.yaml")]);
    expect(out).toContain("0 errors, 4 warnings.");
    const single = capture(["validate", fixture("external-postgres.yaml")]);
    expect(single.out).toMatch(/\d+ errors?, \d+ warnings?\./);
  });

  it("emits a machine-readable report under --json", () => {
    const { out, code } = capture(["validate", fixture("paa-scaled.yaml"), "--json"]);
    const report = JSON.parse(out) as JsonReport;
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.errors).toBe(1);
    expect(report.findings.map((f) => f.code)).toContain("paa-replicas");
    expect(report.manifest).toContain("paa-scaled.yaml");
  });

  it("reports ok: true under --json when only warnings are present", () => {
    const { out } = capture(["validate", fixture("default.yaml"), "--json"]);
    const report = JSON.parse(out) as JsonReport;
    expect(report.ok).toBe(true);
    expect(report.warnings).toBeGreaterThan(0);
  });
});

describe("argument handling", () => {
  it("defaults to ./ojuri.yaml when no path is given", () => {
    const { out } = capture(["validate"]);
    expect(out).toContain("ojuri.yaml");
  });

  it("prints usage and exits 0 for --help", () => {
    const { code, out } = capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("ojuri validate");
  });

  it("prints usage and exits 1 when given no command", () => {
    const { code, out } = capture([]);
    expect(code).toBe(1);
    expect(out).toContain("Usage:");
  });

  it("prints the version", () => {
    const { code, out } = capture(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  it("rejects an unknown command", () => {
    const { code, err } = capture(["deploy"]);
    expect(code).toBe(1);
    expect(err).toContain('Unknown command "deploy"');
  });

  it("rejects an unknown option without throwing", () => {
    const { code, err } = capture(["validate", "--wat"]);
    expect(code).toBe(1);
    expect(err).not.toBe("");
  });

  it("advertises the commands that exist and no others", () => {
    const { out } = capture(["--help"]);
    expect(out).toContain("ojuri validate");
    expect(out).toContain("ojuri render");
    expect(out).not.toContain("ojuri up");
    expect(out).not.toContain("ojuri doctor");
  });
});

describe("prose style", () => {
  // The repo writes British English and bans em-dashes. CLI output is
  // prose the adopter reads, so it is held to the same rule.
  it("uses no em-dashes anywhere in the output", () => {
    for (const name of ["default.yaml", "paa-scaled.yaml", "fia-scaled.yaml", "mla-scaled.yaml"]) {
      const { out } = capture(["validate", fixture(name)]);
      expect(out).not.toContain("—");
    }
    expect(capture(["--help"]).out).not.toContain("—");
  });
});

describe("render command", () => {
  function outDir(): string {
    return mkdtempSync(join(tmpdir(), "ojuri-render-"));
  }

  it("writes both files and prints the command", () => {
    const dir = outDir();
    const { code, out } = capture(["render", fixture("default.yaml"), "--out-dir", dir]);
    expect(code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([".env.rendered", "docker-compose.override.ojuri.yml"]);
    expect(out).toContain("docker compose");
    expect(out).toContain("-f docker-compose.ghcr.yml");
  });

  it("says plainly when the overlay is empty", () => {
    const { out } = capture(["render", fixture("default.yaml"), "--out-dir", outDir()]);
    expect(out).toContain("describes the shipped stack exactly");
  });

  it("still prints the warnings the manifest earns", () => {
    const { out } = capture(["render", fixture("default.yaml"), "--out-dir", outDir()]);
    expect(out).toContain("predict");
  });

  it("refuses to render a manifest with errors, and writes nothing", () => {
    const dir = outDir();
    const { code, err } = capture(["render", fixture("paa-scaled.yaml"), "--out-dir", dir]);
    expect(code).toBe(1);
    expect(err).toContain("Nothing was rendered");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("--print-command writes nothing, since inspecting is not changing", () => {
    const dir = outDir();
    const { code, out } = capture([
      "render",
      fixture("default.yaml"),
      "--out-dir",
      dir,
      "--print-command",
    ]);
    expect(code).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(out.trim().startsWith("docker compose")).toBe(true);
  });

  it("--build drops the GHCR overlay", () => {
    const { out } = capture([
      "render",
      fixture("default.yaml"),
      "--print-command",
      "--build",
      "--out-dir",
      outDir(),
    ]);
    expect(out).not.toContain("docker-compose.ghcr.yml");
    expect(out).toContain("-f docker-compose.yml");
  });

  it("emits a machine-readable report under --json", () => {
    const dir = outDir();
    const { out, code } = capture(["render", fixture("fia-scaled.yaml"), "--out-dir", dir, "--json"]);
    const report = JSON.parse(out) as {
      ok: boolean;
      profiles: string[];
      command: string;
      env: Record<string, string>;
    };
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.profiles).toContain("fia");
    expect(report.command).toContain("--profile fia");
  });

  it("reports failure under --json without writing", () => {
    const dir = outDir();
    const { out, code } = capture(["render", fixture("mla-scaled.yaml"), "--out-dir", dir, "--json"]);
    expect(code).toBe(1);
    expect((JSON.parse(out) as { ok: boolean }).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes an overlay that names the dropped service", () => {
    const dir = outDir();
    capture(["render", fixture("external-postgres.yaml"), "--out-dir", dir]);
    const overlay = readFileSync(join(dir, "docker-compose.override.ojuri.yml"), "utf8");
    expect(overlay).toContain("postgres: !reset null");
    expect(overlay).toContain("depends_on: !override");
  });
});
