import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { init, TEMPLATE_MANIFEST } from "../src/commands/init";
import { readEnvValue, replaceUrlPassword, setEnvValue } from "../src/envfile";
import { parseDotenv } from "../src/manifest/env";
import { ADMIN_PASSWORD_MIN_LENGTH } from "../src/secrets";
import { validateManifest } from "../src/validate";
import { EMPTY_ENV } from "./helpers";

const REPO = join(__dirname, "..", "..", "..");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ojuri-init-"));
  copyFileSync(join(REPO, ".env.example"), join(dir, ".env.example"));
  return dir;
}

describe("setEnvValue", () => {
  it("replaces an existing assignment in place", () => {
    expect(setEnvValue("A=1\nB=2\n", "B", "9")).toBe("A=1\nB=9\n");
  });

  it("uncomments and fills a commented-out one", () => {
    expect(setEnvValue("# ADMIN_SEED_PASSWORD=\n", "ADMIN_SEED_PASSWORD", "x")).toBe(
      "ADMIN_SEED_PASSWORD=x\n"
    );
  });

  it("appends when the key is absent", () => {
    expect(setEnvValue("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
  });

  it("keeps every comment around the line it changes", () => {
    const text = "# leading\nA=1\n# trailing\n";
    expect(setEnvValue(text, "A", "2")).toBe("# leading\nA=2\n# trailing\n");
  });

  it("does not match a key that merely shares a prefix", () => {
    expect(setEnvValue("DB_PASSWORD_EXTRA=1\n", "DB_PASSWORD", "x")).toBe(
      "DB_PASSWORD_EXTRA=1\nDB_PASSWORD=x\n"
    );
  });
});

describe("replaceUrlPassword", () => {
  it("swaps the password and leaves the rest alone", () => {
    expect(replaceUrlPassword("postgresql://postgres:old@localhost:5433/fraud_db", "new")).toBe(
      "postgresql://postgres:new@localhost:5433/fraud_db"
    );
  });

  it("leaves a URL with no credentials alone", () => {
    expect(replaceUrlPassword("postgresql://localhost:5433/fraud_db", "new")).toBe(
      "postgresql://localhost:5433/fraud_db"
    );
  });

  it("does not throw on nonsense", () => {
    expect(replaceUrlPassword("not a url", "new")).toBe("not a url");
  });
});

describe("init", () => {
  it("writes a manifest that validates", () => {
    const dir = project();
    const result = init({ dir });
    expect(result.ok).toBe(true);
    expect(result.wroteManifest).toBe(true);
    expect(validateManifest(result.manifestPath, EMPTY_ENV).ok).toBe(true);
  });

  it("writes a .env from .env.example", () => {
    const dir = project();
    init({ dir });
    expect(existsSync(join(dir, ".env"))).toBe(true);
  });

  it("generates a JWT secret that passes RDA's production guard", () => {
    const dir = project();
    init({ dir });
    const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
    const secret = env.AUTH_JWT_SECRET ?? "";
    expect(secret.startsWith("dev-only-secret")).toBe(false);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("generates an admin password over the migration's 12-character floor", () => {
    const dir = project();
    const result = init({ dir });
    expect(result.adminPassword?.length).toBeGreaterThanOrEqual(ADMIN_PASSWORD_MIN_LENGTH);
    const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.ADMIN_SEED_PASSWORD).toBe(result.adminPassword);
  });

  it("moves POSTGRES_PASSWORD, DB_PASSWORD and DB_URL together", () => {
    // The container takes POSTGRES_PASSWORD; host-side tooling reads the
    // other two. Changing one without the others leaves a checkout where
    // `npm run db:migrate` cannot authenticate against the database the
    // same .env just started.
    const dir = project();
    init({ dir });
    const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
    const password = env.POSTGRES_PASSWORD ?? "";

    expect(password).not.toBe("postgres");
    expect(env.DB_PASSWORD).toBe(password);
    expect(env.DB_URL).toContain(`:${password}@`);
  });

  it("generates secrets with no characters that need URL-encoding", () => {
    for (let i = 0; i < 20; i += 1) {
      const dir = project();
      init({ dir });
      const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
      expect(env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(env.AUTH_JWT_SECRET).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(env.ADMIN_SEED_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("gives a different secret every run", () => {
    const first = project();
    const second = project();
    init({ dir: first });
    init({ dir: second });
    const a = parseDotenv(readFileSync(join(first, ".env"), "utf8"));
    const b = parseDotenv(readFileSync(join(second, ".env"), "utf8"));
    expect(a.AUTH_JWT_SECRET).not.toBe(b.AUTH_JWT_SECRET);
    expect(a.ADMIN_SEED_PASSWORD).not.toBe(b.ADMIN_SEED_PASSWORD);
  });

  it("leaves MLA_SERVICE_TOKEN alone, which is a separate hardening job", () => {
    const dir = project();
    init({ dir });
    const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.MLA_SERVICE_TOKEN).toContain("dev-only");
  });

  it("keeps the development defaults under --keep-dev-defaults", () => {
    const dir = project();
    const result = init({ dir, keepDevDefaults: true });
    const env = parseDotenv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.AUTH_JWT_SECRET).toContain("dev-only-secret");
    expect(result.adminPassword).toBeUndefined();
  });

  it("refuses to overwrite an existing .env", () => {
    const dir = project();
    writeFileSync(join(dir, ".env"), "MINE=keep\n", "utf8");
    const result = init({ dir });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("MINE=keep\n");
    expect(result.wroteEnv).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("refuses to overwrite an existing manifest", () => {
    const dir = project();
    writeFileSync(join(dir, "ojuri.yaml"), "version: 1\n# mine\n", "utf8");
    init({ dir });
    expect(readFileSync(join(dir, "ojuri.yaml"), "utf8")).toContain("# mine");
  });

  it("is safe to run twice", () => {
    const dir = project();
    init({ dir });
    const before = readFileSync(join(dir, ".env"), "utf8");
    const second = init({ dir });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
    expect(second.ok).toBe(true);
  });

  it("fails clearly when there is no .env.example to copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "ojuri-bare-"));
    const result = init({ dir });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(".env.example");
  });
});

describe("the shipped manifest template", () => {
  it("is identical to the committed ojuri.yaml", () => {
    // Two copies of the default manifest would drift, and an adopter's
    // `ojuri init` would then describe a different stack from the repo's.
    expect(readFileSync(TEMPLATE_MANIFEST, "utf8")).toBe(
      readFileSync(join(REPO, "ojuri.yaml"), "utf8")
    );
  });

  it("parses and describes the shipped stack", () => {
    const doc = parseYaml(readFileSync(TEMPLATE_MANIFEST, "utf8")) as { version: number };
    expect(doc.version).toBe(1);
  });
});

describe(".env.example", () => {
  it("documents ADMIN_SEED_PASSWORD without setting it", () => {
    // A commented line changes nothing for the README path, and puts the
    // variable where people look for it.
    const text = readFileSync(join(REPO, ".env.example"), "utf8");
    expect(text).toContain("# ADMIN_SEED_PASSWORD=");
    expect(readEnvValue(text, "ADMIN_SEED_PASSWORD")).toBeUndefined();
  });

  it("says the value only applies to a fresh database, and names the length floor", () => {
    const text = readFileSync(join(REPO, ".env.example"), "utf8");
    expect(text).toContain("FRESH database");
    expect(text).toContain("at least 12 characters");
  });

  it("still ships the development JWT secret, so the manual path stays honest", () => {
    const env = parseDotenv(readFileSync(join(REPO, ".env.example"), "utf8"));
    expect(env.AUTH_JWT_SECRET).toContain("dev-only-secret");
  });
});
