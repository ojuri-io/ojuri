import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAdmin } from "../src/commands/reset-admin";
import type { Exec, ExecResult } from "../src/exec";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ojuri-reset-"));
  writeFileSync(join(dir, "ojuri.yaml"), "version: 1\n", "utf8");
  writeFileSync(join(dir, ".env"), "AUTH_JWT_SECRET=" + "a".repeat(40) + "\n", "utf8");
  return dir;
}

function recorder(handler: (argv: string[]) => ExecResult): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: { run: (argv) => (calls.push(argv), handler(argv)) } };
}

const issued = (password: string): ExecResult => ({ status: 0, stdout: `${password}\n`, stderr: "" });

describe("reset-admin", () => {
  it("runs inside the RDA container, which has bcrypt and knex but no scripts/", () => {
    const dir = project();
    const rec = recorder(() => issued("Generated-One-2345"));

    const result = resetAdmin(join(dir, "ojuri.yaml"), {}, { exec: rec.exec });

    expect(result.ok).toBe(true);
    const argv = rec.calls[0] ?? [];
    expect(argv.slice(argv.indexOf("exec"), argv.indexOf("exec") + 2)).toEqual(["exec", "-T"]);
    expect(argv).toContain("rda");
    // Node resolves modules from the script's directory, and the script
    // is passed inline rather than written into /app.
    expect(argv).toContain("NODE_PATH=/app/node_modules");
    expect(result.lines.join("\n")).toContain("Generated-One-2345");
  });

  it("passes a chosen password rather than generating one", () => {
    const dir = project();
    const rec = recorder(() => issued("chosen-secret-1234"));

    resetAdmin(join(dir, "ojuri.yaml"), { password: "chosen-secret-1234" }, { exec: rec.exec });

    expect(rec.calls[0]).toContain("OJURI_NEW_PASSWORD=chosen-secret-1234");
  });

  it("refuses a password the server would reject, without touching Docker", () => {
    const dir = project();
    const rec = recorder(() => issued("unused"));

    const result = resetAdmin(join(dir, "ojuri.yaml"), { password: "short" }, { exec: rec.exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("at least 12");
    expect(rec.calls).toEqual([]);
  });

  it("targets a different user and tenant when asked", () => {
    const dir = project();
    const rec = recorder(() => issued("Generated-One-2345"));

    resetAdmin(join(dir, "ojuri.yaml"), { username: "alice", tenant: "acme" }, { exec: rec.exec });

    expect(rec.calls[0]).toContain("OJURI_USERNAME=alice");
    expect(rec.calls[0]).toContain("OJURI_TENANT=acme");
  });

  it("says the user does not exist rather than reporting a generic failure", () => {
    const dir = project();
    const rec = recorder(() => ({ status: 1, stdout: "", stderr: "NOUSER\n" }));

    const result = resetAdmin(join(dir, "ojuri.yaml"), { username: "nobody" }, { exec: rec.exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("No user nobody in tenant default");
  });

  it("points at the stack when it is not running, which is the likely cause", () => {
    const dir = project();
    const rec = recorder(() => ({
      status: 1,
      stdout: "",
      stderr: 'service "rda" is not running',
    }));

    const result = resetAdmin(join(dir, "ojuri.yaml"), {}, { exec: rec.exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("has to be running");
    expect(result.errors.join("\n")).toContain("ojuri status");
  });
});
