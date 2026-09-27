import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_FILES, RUNTIME_DIRECTORIES } from "../src/stack/assets";
import { locateStack } from "../src/stack/locate";
import { materialiseStack } from "../src/stack/materialise";
import { projectNameFor } from "../src/stack/project-name";
import { resolveStack } from "../src/stack/resolve";
import { composeCommand } from "../src/render/command";
import { effective, type Manifest } from "../src/manifest/types";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "ojuri-bundle-"));
  mkdirSync(join(dir, "stack", "nginx"), { recursive: true });
  writeFileSync(join(dir, "stack", "docker-compose.yml"), "services: {}\n", "utf8");
  writeFileSync(join(dir, "stack", "nginx", "nginx.conf"), "worker_processes 1;\n", "utf8");
  writeFileSync(join(dir, "stack", ".env.example"), "AUTH_JWT_SECRET=dev\n", "utf8");
  return dir;
}

describe("the bundled asset list", () => {
  it("names every host path docker-compose.yml bind-mounts", () => {
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const mounted = new Set(
      [...compose.matchAll(/-\s+\.\/([^:\s]+):/g)].map((m) => (m[1] ?? "").replace(/\/$/, ""))
    );

    const covered = new Set<string>([...BUNDLED_FILES, ...RUNTIME_DIRECTORIES]);
    const uncovered = [...mounted].filter(
      (path) => !covered.has(path) && ![...covered].some((c) => c.startsWith(`${path}/`))
    );

    expect(uncovered).toEqual([]);
  });

  it("names only files that exist in the repository", () => {
    const missing = BUNDLED_FILES.filter((relative) => !existsSync(join(REPO_ROOT, relative)));
    expect(missing).toEqual([]);
  });
});

describe("locateStack", () => {
  it("prefers the bundled stack over walking up to a checkout", () => {
    const packaged = bundle();

    const found = locateStack(packaged, REPO_ROOT);

    expect(found).toEqual({ root: join(packaged, "stack"), bundled: true });
  });

  it("walks up to the checkout when nothing is bundled", () => {
    const empty = mkdtempSync(join(tmpdir(), "ojuri-nobundle-"));

    const found = locateStack(empty, join(REPO_ROOT, "packages", "cli", "src"));

    expect(found).toEqual({ root: REPO_ROOT, bundled: false });
  });

  it("returns null when there is no stack in either place", () => {
    const empty = mkdtempSync(join(tmpdir(), "ojuri-nothing-"));
    expect(locateStack(empty, empty)).toBeNull();
  });
});

describe("materialiseStack", () => {
  it("copies the bundle out and creates the directories Compose writes into", () => {
    const packaged = bundle();
    const target = join(mkdtempSync(join(tmpdir(), "ojuri-target-")), "stack");

    const result = materialiseStack({ root: join(packaged, "stack"), bundled: true }, target);

    expect(result.copied).toContain("docker-compose.yml");
    expect(result.copied).toContain("nginx/nginx.conf");
    expect(existsSync(join(target, "nginx", "nginx.conf"))).toBe(true);
    for (const dir of RUNTIME_DIRECTORIES) {
      expect(existsSync(join(target, dir))).toBe(true);
    }
  });

  it("keeps a file an operator has already edited", () => {
    const packaged = bundle();
    const target = join(mkdtempSync(join(tmpdir(), "ojuri-edited-")), "stack");
    mkdirSync(join(target, "nginx"), { recursive: true });
    writeFileSync(join(target, "nginx", "nginx.conf"), "# mine\n", "utf8");

    const result = materialiseStack({ root: join(packaged, "stack"), bundled: true }, target);

    expect(result.kept).toContain("nginx/nginx.conf");
    expect(readFileSync(join(target, "nginx", "nginx.conf"), "utf8")).toBe("# mine\n");
  });

  it("does nothing when the stack is a checkout", () => {
    const result = materialiseStack({ root: REPO_ROOT, bundled: false }, "/nonexistent");

    expect(result).toEqual({ stackDir: REPO_ROOT, copied: [], kept: [] });
  });
});

describe("projectNameFor", () => {
  it.each([
    ["/home/me/ojuri", "ojuri"],
    ["/home/me/My Fraud POC", "my-fraud-poc"],
    ["/home/me/2024_pilot", "2024_pilot"],
    ["/home/me/-leading-dash", "leading-dash"],
    ["/", "ojuri"],
  ])("names %p as %p", (dir, expected) => {
    expect(projectNameFor(dir)).toBe(expected);
  });
});

describe("resolveStack", () => {
  it("prefers a materialised stack over the checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ojuri-resolve-"));
    mkdirSync(join(dir, ".ojuri", "stack"), { recursive: true });
    writeFileSync(join(dir, ".ojuri", "stack", "docker-compose.yml"), "services: {}\n", "utf8");

    expect(resolveStack(dir, ".ojuri")).toEqual({
      stackDir: join(".ojuri", "stack"),
      projectName: projectNameFor(dir),
    });
  });

  it("agrees with itself across repeated calls, so down addresses what up started", () => {
    const dir = mkdtempSync(join(tmpdir(), "ojuri-agree-"));
    expect(resolveStack(dir, ".ojuri")).toEqual(resolveStack(dir, ".ojuri"));
  });
});

describe("composeArgs with a relocated stack", () => {
  const plan = { cfg: effective({ version: 1 } as Manifest), profiles: [] } as never;

  it("passes the project name and project directory, and reads the stack's compose files", () => {
    const argv = composeCommand(plan, {
      build: false,
      outDir: ".ojuri",
      envFile: ".env",
      stackDir: ".ojuri/stack",
      projectName: "my-poc",
    });

    expect(argv.slice(0, 6)).toEqual([
      "docker",
      "compose",
      "-p",
      "my-poc",
      "--project-directory",
      ".ojuri/stack",
    ]);
    expect(argv).toContain(".ojuri/stack/docker-compose.yml");
    expect(argv).toContain(".ojuri/stack/docker-compose.ghcr.yml");
    expect(argv).toContain(".ojuri/docker-compose.override.ojuri.yml");
  });

  it("stays byte-identical to the old invocation when the stack is the checkout", () => {
    const before = composeCommand(plan, { build: false, outDir: ".ojuri", envFile: ".env" });

    expect(before).not.toContain("--project-directory");
    expect(before).toContain("docker-compose.yml");
  });
});
