import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { derivedCorsOrigins, LOCAL_DEV_ORIGINS } from "../src/manifest/cors";
import { parseDotenv } from "../src/manifest/env";
import type { Manifest } from "../src/manifest/types";
import { composeCommand, formatCommand } from "../src/render/command";
import { SERVICE } from "../src/render/compose-base";
import { renderEnvFile } from "../src/render/env-file";
import { isNoOp, renderOverlay } from "../src/render/overlay";
import { buildPlan, parsePostgresUrl } from "../src/render/plan";
import { render } from "../src/render";
import { EMPTY_ENV, errorCodes, fixture } from "./helpers";

const REPO = join(__dirname, "..", "..", "..");

function plan(manifest: Manifest) {
  return buildPlan(manifest);
}

const DEFAULT: Manifest = { version: 1 };

describe("SENTINEL_CORS_ORIGINS cannot drift from validate", () => {
  // `ojuri validate` checks the allowlist against RDA's production
  // guard and `ojuri render` writes it into the stack. If these two
  // ever computed it differently, validate would pass a manifest that
  // renders to a stack RDA refuses to boot. One function, pinned here.
  const urls = [
    "http://localhost",
    "http://localhost:8080",
    "http://127.0.0.1",
    "https://sentinel.example.com",
    "https://ojuri.example.com:8443",
    "http://sentinel.internal",
  ];

  it.each(urls)("render writes derivedCorsOrigins(%s) verbatim", (url) => {
    expect(plan({ version: 1, network: { public_url: url } }).env.SENTINEL_CORS_ORIGINS).toBe(
      derivedCorsOrigins(url)
    );
  });

  it("holds for the default manifest, where public_url is defaulted rather than written", () => {
    expect(plan(DEFAULT).env.SENTINEL_CORS_ORIGINS).toBe(derivedCorsOrigins("http://localhost"));
  });

  it("holds after a trailing slash is stripped", () => {
    const withSlash = plan({ version: 1, network: { public_url: "https://x.example.com/" } });
    expect(withSlash.env.SENTINEL_CORS_ORIGINS).toBe(derivedCorsOrigins("https://x.example.com"));
  });

  it("gives a local origin the dev server entries, and a public one only itself", () => {
    expect(derivedCorsOrigins("http://localhost")).toBe(LOCAL_DEV_ORIGINS);
    expect(derivedCorsOrigins("https://sentinel.example.com")).toBe("https://sentinel.example.com");
  });
});

describe("the default manifest renders to a no-op", () => {
  it("produces an empty overlay", () => {
    const p = plan(DEFAULT);
    expect(isNoOp(p.overlay)).toBe(true);
    expect(p.dropped).toEqual([]);
    expect(p.profiles).toEqual([]);
  });

  it("produces an overlay Compose can still parse", () => {
    const doc = parseYaml(renderOverlay(plan(DEFAULT)));
    expect(doc).toEqual({ services: {} });
  });

  it("matches .env.example on every field it controls", () => {
    // The requirement is value-identity, not file-identity: .env.example
    // carries many fields the manifest does not control.
    const example = parseDotenv(readFileSync(join(REPO, ".env.example"), "utf8"));
    const rendered = plan(DEFAULT).env;

    for (const [key, value] of Object.entries(rendered)) {
      expect([key, value]).toEqual([key, example[key]]);
    }
  });

  it("controls exactly the four fields the shipped stack needs", () => {
    expect(Object.keys(plan(DEFAULT).env).sort()).toEqual([
      "OJURI_VERSION",
      "RDA_REPLICAS",
      "RDA_REQUIRE_API_KEY",
      "SENTINEL_CORS_ORIGINS",
    ]);
  });
});

describe("external datastores", () => {
  const externalPg: Manifest = {
    version: 1,
    datastores: {
      postgres: { mode: "external", url: "postgresql://ojuri:s3cret@db.internal:6432/fraud_db" },
    },
  };

  it("drops the postgres service", () => {
    expect(plan(externalPg).dropped).toEqual([SERVICE.postgres]);
  });

  it("keeps db-migrate, which still has to run", () => {
    const overlay = plan(externalPg).overlay.services;
    expect(overlay[SERVICE.dbMigrate]?.reset).toBeUndefined();
    expect(overlay[SERVICE.dbMigrate]?.environment?.DB_HOST).toBe("db.internal");
  });

  it("rebuilds every dependant's depends_on rather than leaving a dangling reference", () => {
    // Compose refuses a project whose depends_on names a service that
    // no longer exists, and !override replaces the map wholesale, so
    // the surviving edges have to be restated.
    const overlay = plan(externalPg).overlay.services;
    expect(overlay[SERVICE.rda]?.dependsOn).toEqual({
      redis: "service_healthy",
      kafka: "service_healthy",
      "db-migrate": "service_completed_successfully",
    });
    expect(overlay[SERVICE.dbMigrate]?.dependsOn).toBeNull();
  });

  it("overrides the hostname literals compose hardcodes, per service", () => {
    const overlay = plan({ ...externalPg, services: { fia: { enabled: true } } }).overlay.services;
    expect(overlay[SERVICE.rda]?.environment?.DB_URL).toContain("db.internal");
    expect(overlay[SERVICE.paa]?.environment?.DB_URL).toContain("db.internal");
    expect(overlay[SERVICE.fia]?.environment?.POSTGRES_HOST).toBe("db.internal");
  });

  it("does not touch a disabled service's environment", () => {
    const overlay = plan(externalPg).overlay.services;
    expect(overlay[SERVICE.fia]?.environment).toBeUndefined();
  });

  it("takes zookeeper with kafka, and never on its own", () => {
    const externalKafka = plan({
      version: 1,
      datastores: { kafka: { mode: "external", brokers: "b1:9092,b2:9092" } },
    });
    expect(externalKafka.dropped).toEqual([SERVICE.kafka, SERVICE.zookeeper]);
    expect(plan(externalPg).dropped).not.toContain(SERVICE.zookeeper);
  });

  it("points every Kafka client at the external brokers", () => {
    const overlay = plan({
      version: 1,
      datastores: { kafka: { mode: "external", brokers: "b1:9092" } },
      services: { fia: { enabled: true }, mla: { enabled: true } },
    }).overlay.services;
    for (const name of [SERVICE.rda, SERVICE.paa, SERVICE.fia, SERVICE.mla]) {
      expect(overlay[name]?.environment?.KAFKA_BROKERS).toBe("b1:9092");
    }
  });

  it("defaults an external Redis port and omits an unset password", () => {
    const overlay = plan({
      version: 1,
      datastores: { redis: { mode: "external", host: "cache.internal" } },
    }).overlay.services;
    expect(overlay[SERVICE.rda]?.environment?.REDIS_PORT).toBe("6379");
    expect(overlay[SERVICE.rda]?.environment?.REDIS_PASSWORD).toBeUndefined();
  });
});

describe("parsePostgresUrl", () => {
  it("splits a full URL", () => {
    expect(parsePostgresUrl("postgresql://u:p@h.internal:6432/db")).toEqual({
      host: "h.internal",
      port: "6432",
      database: "db",
      username: "u",
      password: "p",
    });
  });

  it("falls back to the compose defaults for anything omitted", () => {
    expect(parsePostgresUrl("postgresql://h.internal/")).toEqual({
      host: "h.internal",
      port: "5432",
      database: "fraud_db",
      username: "postgres",
      password: "",
    });
  });

  it("decodes a percent-encoded password", () => {
    expect(parsePostgresUrl("postgresql://u:p%40ss%3Aword@h/db").password).toBe("p@ss:word");
  });

  it("does not throw on an unparseable URL", () => {
    expect(() => parsePostgresUrl("not a url")).not.toThrow();
  });
});

describe("observability", () => {
  it("removes both services, since neither carries a profile to withhold", () => {
    const p = plan({ version: 1, observability: { enabled: false } });
    expect(p.dropped).toEqual([SERVICE.prometheus, SERVICE.grafana]);
    expect(p.overlay.services[SERVICE.grafana]?.reset).toBe(true);
  });
});

describe("replicas", () => {
  it("scales RDA through RDA_REPLICAS and adds no second mechanism", () => {
    const p = plan({ version: 1, services: { rda: { replicas: 5 } } });
    expect(p.env.RDA_REPLICAS).toBe("5");
    expect(p.overlay.services[SERVICE.rda]?.replicas).toBeUndefined();
  });

  it("drops FIA's fixed host port when it scales, since 9094 cannot be published twice", () => {
    const overlay = plan({ version: 1, services: { fia: { enabled: true, replicas: 3 } } })
      .overlay.services;
    expect(overlay[SERVICE.fia]?.replicas).toBe(3);
    expect(overlay[SERVICE.fia]?.resetPorts).toBe(true);
  });

  it("leaves the port alone at a single replica", () => {
    const overlay = plan({ version: 1, services: { fia: { enabled: true, replicas: 1 } } })
      .overlay.services;
    expect(overlay[SERVICE.fia]?.resetPorts).toBeUndefined();
  });

  it("ignores replicas on a disabled service", () => {
    const overlay = plan({ version: 1, services: { fia: { enabled: false, replicas: 3 } } })
      .overlay.services;
    expect(overlay[SERVICE.fia]).toBeUndefined();
  });
});

describe("profiles and MLA health", () => {
  it("activates a profile per enabled service", () => {
    const p = plan({
      version: 1,
      services: { fia: { enabled: true }, mla: { enabled: true }, sentinel: { enabled: true } },
    });
    expect(p.profiles.sort()).toEqual(["fia", "mla", "sentinel"]);
  });

  it("repoints the MLA health probe at the in-compose service", () => {
    expect(plan({ version: 1, services: { mla: { enabled: true } } }).env.MLA_HEALTH_URL).toBe(
      "http://mla:9095"
    );
  });

  it("leaves MLA_HEALTH_URL alone when MLA is off, so the default stack is untouched", () => {
    expect(plan(DEFAULT).env.MLA_HEALTH_URL).toBeUndefined();
  });
});

describe("nginx", () => {
  it("swaps the config bind mount when Sentinel is enabled", () => {
    const overlay = plan({ version: 1, services: { sentinel: { enabled: true } } })
      .overlay.services;
    expect(overlay[SERVICE.nginx]?.volumes).toEqual([
      "./nginx/nginx.sentinel.conf:/etc/nginx/nginx.conf:ro",
    ]);
  });

  it("leaves the default config in place when Sentinel is off", () => {
    expect(plan(DEFAULT).overlay.services[SERVICE.nginx]).toBeUndefined();
  });

  it("republishes the port only when it is not 80", () => {
    expect(plan({ version: 1, network: { http_port: 80 } }).overlay.services[SERVICE.nginx])
      .toBeUndefined();
    expect(
      plan({ version: 1, network: { http_port: 8080 } }).overlay.services[SERVICE.nginx]?.ports
    ).toEqual(["8080:80"]);
  });
});

describe("per-service overrides", () => {
  it("passes image and resources through", () => {
    const overlay = plan({
      version: 1,
      services: { rda: { image: "my.registry/rda:x", resources: { cpu: "2", memory: "4G" } } },
    }).overlay.services;
    expect(overlay[SERVICE.rda]?.image).toBe("my.registry/rda:x");
    expect(overlay[SERVICE.rda]?.resources).toEqual({ cpu: "2", memory: "4G" });
  });
});

describe("the rendered overlay text", () => {
  it("uses !reset for a dropped service and !override for a rebuilt map", () => {
    const text = renderOverlay(
      plan({ version: 1, datastores: { postgres: { mode: "external", url: "postgresql://h/db" } } })
    );
    expect(text).toContain("postgres: !reset null");
    expect(text).toContain("depends_on: !override");
    expect(text).toContain("depends_on: !override {}");
  });

  it("quotes values so a connection URL's colons cannot be misread as YAML", () => {
    const text = renderOverlay(
      plan({
        version: 1,
        datastores: { postgres: { mode: "external", url: "postgresql://u:p@h:5432/db" } },
      })
    );
    expect(text).toContain('DB_URL: "postgresql://u:p@h:5432/db"');
  });

  it("says it is generated and must not be edited", () => {
    expect(renderOverlay(plan(DEFAULT))).toContain("Do not edit");
    expect(renderEnvFile(plan(DEFAULT))).toContain("Do not edit");
  });

  it("carries no em-dashes", () => {
    expect(renderOverlay(plan(DEFAULT))).not.toContain("—");
    expect(renderEnvFile(plan(DEFAULT))).not.toContain("—");
  });
});

describe("the compose command", () => {
  const opts = { build: false, outDir: ".ojuri", envFile: ".env", args: ["up", "-d"] };

  it("passes the rendered env file after the adopter's, so it wins", () => {
    const argv = composeCommand(plan(DEFAULT), opts);
    const first = argv.indexOf(".env");
    const second = argv.indexOf(".ojuri/.env.rendered");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("includes the GHCR overlay by default and drops it for --build", () => {
    expect(formatCommand(composeCommand(plan(DEFAULT), opts))).toContain("docker-compose.ghcr.yml");
    expect(
      formatCommand(composeCommand(plan(DEFAULT), { ...opts, build: true }))
    ).not.toContain("docker-compose.ghcr.yml");
  });

  it("appends a --profile per enabled service", () => {
    const argv = composeCommand(
      plan({ version: 1, services: { fia: { enabled: true }, sentinel: { enabled: true } } }),
      opts
    );
    expect(formatCommand(argv)).toContain("--profile fia --profile sentinel");
  });

  it("reproduces the README quick start plus the overlay for the default manifest", () => {
    expect(formatCommand(composeCommand(plan(DEFAULT), opts))).toBe(
      "docker compose --env-file .env --env-file .ojuri/.env.rendered " +
        "-f docker-compose.yml -f docker-compose.ghcr.yml " +
        "-f .ojuri/docker-compose.override.ojuri.yml up -d"
    );
  });
});

describe("render refuses a manifest that does not validate", () => {
  it("writes nothing when a rule fails", () => {
    const result = render(fixture("paa-scaled.yaml"), { dryRun: false, processEnv: EMPTY_ENV });
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(errorCodes(result.findings)).toContain("paa-replicas");
  });

  it("writes nothing when the schema fails", () => {
    const result = render(fixture("bad-version.yaml"), { processEnv: EMPTY_ENV });
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
  });

  it("renders a manifest whose only findings are warnings", () => {
    const result = render(fixture("default.yaml"), { dryRun: true, processEnv: EMPTY_ENV });
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.noOp).toBe(true);
  });

  it("writes nothing on a dry run", () => {
    const result = render(fixture("default.yaml"), { dryRun: true, processEnv: EMPTY_ENV });
    expect(result.written).toEqual([]);
    expect(result.command).not.toBe("");
  });
});
