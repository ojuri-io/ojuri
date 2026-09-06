import { adminOutcome, migrateOutcome, parsePs } from "../src/commands/stack";
import { baseUrl, probeTargets, summaryUrls } from "../src/commands/urls";
import { effective, type Manifest } from "../src/manifest/types";

const noEnv = { dotenv: {}, process: {} };

function cfg(manifest: Manifest = { version: 1 }) {
  return effective(manifest);
}

describe("parsePs", () => {
  it("reads the JSON-array form", () => {
    const states = parsePs('[{"Service":"rda","State":"running","Health":"healthy"}]');
    expect(states).toEqual([
      { service: "rda", state: "running", exitCode: null, health: "healthy" },
    ]);
  });

  it("reads the newline-delimited form", () => {
    // Compose emits one or the other depending on version, so both have
    // to work or `up` hangs waiting for a migration that already ran.
    const states = parsePs(
      '{"Service":"db-migrate","State":"exited","ExitCode":0}\n{"Service":"rda","State":"running"}'
    );
    expect(states.map((s) => s.service)).toEqual(["db-migrate", "rda"]);
    expect(states[0]?.exitCode).toBe(0);
  });

  it("survives empty output and noise", () => {
    expect(parsePs("")).toEqual([]);
    expect(parsePs("   ")).toEqual([]);
    expect(parsePs("not json\n{\"Service\":\"rda\",\"State\":\"running\"}")).toHaveLength(1);
  });

  it("does not throw on malformed JSON", () => {
    expect(() => parsePs("[{oops")).not.toThrow();
    expect(parsePs("[{oops")).toEqual([]);
  });
});

describe("migrateOutcome", () => {
  it("is pending while the container has not exited", () => {
    expect(migrateOutcome(parsePs('[{"Service":"db-migrate","State":"running"}]'))).toBe("pending");
  });

  it("is pending when the container is not there yet", () => {
    expect(migrateOutcome([])).toBe("pending");
  });

  it("succeeds on a clean exit", () => {
    expect(
      migrateOutcome(parsePs('[{"Service":"db-migrate","State":"exited","ExitCode":0}]'))
    ).toBe("succeeded");
  });

  it("fails on a non-zero exit", () => {
    expect(
      migrateOutcome(parsePs('[{"Service":"db-migrate","State":"exited","ExitCode":1}]'))
    ).toBe("failed");
  });
});

describe("adminOutcome", () => {
  const banner = `
════════════════════════════
  Ojuri admin user seeded
  username: admin
  password: Sq0PcqJ1hy7Qv03tjsbSUBMl
  This password is shown once and won't be printed again.
`;

  it("reads a generated password out of the migration banner", () => {
    expect(adminOutcome(banner, undefined)).toEqual({
      kind: "generated",
      password: "Sq0PcqJ1hy7Qv03tjsbSUBMl",
    });
  });

  it("prefers the banner even when ADMIN_SEED_PASSWORD is set", () => {
    expect(adminOutcome(banner, "something").kind).toBe("generated");
  });

  it("recognises an existing database from knex's own words", () => {
    expect(adminOutcome("Already up to date", "secret").kind).toBe("existing");
  });

  it("points at .env when the password came from the environment", () => {
    expect(adminOutcome("Batch 1 run: 40 migrations", "secret").kind).toBe("seeded-from-env");
  });

  it("admits when it cannot tell", () => {
    // Better than guessing: the wrong answer sends someone hunting for a
    // password that was never printed.
    expect(adminOutcome("Batch 1 run: 40 migrations", undefined).kind).toBe("unknown");
    expect(adminOutcome("", "").kind).toBe("unknown");
  });
});

describe("baseUrl", () => {
  it("leaves the default alone rather than rendering a redundant :80", () => {
    expect(baseUrl(cfg())).toBe("http://localhost");
  });

  it("appends a non-default http_port", () => {
    expect(baseUrl(cfg({ version: 1, network: { http_port: 8080 } }))).toBe(
      "http://localhost:8080"
    );
  });

  it("keeps an explicit port in public_url", () => {
    expect(
      baseUrl(cfg({ version: 1, network: { public_url: "https://ojuri.example.com:8443" } }))
    ).toBe("https://ojuri.example.com:8443");
  });

  it("does not append 443 to an https origin", () => {
    expect(
      baseUrl(
        cfg({ version: 1, network: { public_url: "https://ojuri.example.com", http_port: 443 } })
      )
    ).toBe("https://ojuri.example.com");
  });
});

describe("probeTargets", () => {
  it("tries NGINX first and the direct port as a fallback", () => {
    const rda = probeTargets(cfg(), noEnv).find((t) => t.name === "rda");
    expect(rda?.urls).toEqual(["http://localhost/ready", "http://localhost:3000/readyz"]);
  });

  it("reaches FIA and MLA through their proxied prefixes", () => {
    const targets = probeTargets(
      cfg({ version: 1, services: { fia: { enabled: true }, mla: { enabled: true } } }),
      noEnv
    );
    expect(targets.find((t) => t.name === "fia")?.urls[0]).toBe("http://localhost/fia/readyz");
    expect(targets.find((t) => t.name === "mla")?.urls[0]).toBe("http://localhost/mla/readyz");
  });

  it("does not probe a service the manifest has switched off", () => {
    expect(probeTargets(cfg(), noEnv).map((t) => t.name)).toEqual(["rda", "paa"]);
  });

  it("honours a *_HEALTH_URL that is actually set", () => {
    const targets = probeTargets(cfg(), {
      dotenv: {},
      process: { RDA_HEALTH_URL: "http://127.0.0.1:3000" },
    });
    expect(targets.find((t) => t.name === "rda")?.urls).toEqual(["http://127.0.0.1:3000/readyz"]);
  });

  it("ignores an empty *_HEALTH_URL, which is how compose says a service is off", () => {
    const targets = probeTargets(cfg(), { dotenv: { RDA_HEALTH_URL: "  " }, process: {} });
    expect(targets.find((t) => t.name === "rda")?.urls[0]).toBe("http://localhost/ready");
  });

  it("ignores a commented-out example, since a comment is not a setting", () => {
    // .env.example ships these commented and describing host-side runs.
    // parseDotenv skips comments, so nothing is set and the NGINX path
    // stays the default.
    const targets = probeTargets(cfg(), { dotenv: {}, process: {} });
    expect(targets.find((t) => t.name === "rda")?.urls[0]).toBe("http://localhost/ready");
  });

  it("follows a non-default http_port", () => {
    const targets = probeTargets(cfg({ version: 1, network: { http_port: 8080 } }), noEnv);
    expect(targets[0]?.urls[0]).toBe("http://localhost:8080/ready");
  });
});

describe("summaryUrls", () => {
  it("points Sentinel at NGINX, not at a host port of its own", () => {
    // 3001 is Grafana's; Sentinel publishes nothing.
    const urls = summaryUrls(cfg({ version: 1, services: { sentinel: { enabled: true } } }));
    expect(urls.sentinel).toBe("http://localhost");
    expect(urls.grafana).toBe("http://localhost:3001");
  });

  it("omits what is not enabled", () => {
    const urls = summaryUrls(cfg({ version: 1, observability: { enabled: false } }));
    expect(urls.sentinel).toBeUndefined();
    expect(urls.grafana).toBeUndefined();
  });
});
