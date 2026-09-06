import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "../src/validate";
import { effective, type Manifest } from "../src/manifest/types";
import { errorCodes, fixture, EMPTY_ENV } from "./helpers";

const ROOT_MANIFEST = join(__dirname, "..", "..", "..", "ojuri.yaml");

describe("the committed ojuri.yaml", () => {
  it("validates with no errors", () => {
    // Deliberately not asserting on warnings: the repo root may or may
    // not have a .env beside it, which changes whether the JWT secret
    // resolves. Errors are the contract.
    const result = validateManifest(ROOT_MANIFEST, EMPTY_ENV);
    expect(errorCodes(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("matches the default fixture field for field", () => {
    // The fixture is what the rule specs are written against. If the two
    // drift, those specs stop describing what adopters actually get.
    const root = parseYaml(readFileSync(ROOT_MANIFEST, "utf8")) as Manifest;
    const fixtureDoc = parseYaml(readFileSync(fixture("default.yaml"), "utf8")) as Manifest;
    expect(root).toEqual(fixtureDoc);
  });

  it("describes the stack a plain docker compose up produces", () => {
    // These are the values in docker-compose.yml and .env.example today.
    // Rendering this manifest has to be a no-op, so a change here is a
    // change to the default stack and should be deliberate.
    const cfg = effective(parseYaml(readFileSync(ROOT_MANIFEST, "utf8")) as Manifest);

    expect(cfg.release).toBe("v1");
    expect(cfg.postgres.mode).toBe("bundled");
    expect(cfg.redis.mode).toBe("bundled");
    expect(cfg.kafka.mode).toBe("bundled");
    expect(cfg.rda.replicas).toBe(3);
    expect(cfg.paa.replicas).toBe(1);
    expect(cfg.mla.enabled).toBe(false);
    expect(cfg.fia.enabled).toBe(false);
    expect(cfg.sentinel.enabled).toBe(false);
    expect(cfg.requireApiKey).toBe(false);
    expect(cfg.httpPort).toBe(80);
    expect(cfg.observabilityEnabled).toBe(true);
  });

  it("carries no em-dashes in its comments", () => {
    expect(readFileSync(ROOT_MANIFEST, "utf8")).not.toContain("—");
  });
});

describe("effective defaults", () => {
  it("fills an empty manifest with the shipped stack", () => {
    const cfg = effective({});
    expect(cfg.rda.replicas).toBe(3);
    expect(cfg.paa.replicas).toBe(1);
    expect(cfg.observabilityEnabled).toBe(true);
    expect(cfg.publicUrl).toBe("http://localhost");
  });

  it("strips a trailing slash from public_url so CORS gets a bare origin", () => {
    expect(effective({ network: { public_url: "https://sentinel.example.com/" } }).publicUrl).toBe(
      "https://sentinel.example.com"
    );
  });
});
