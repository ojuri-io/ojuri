import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BASE_DEPENDS_ON,
  COMPOSE_FILE,
  COMPOSE_FILE_GHCR,
  NGINX_CONFIG_DEFAULT,
  NGINX_CONFIG_SENTINEL,
  NGINX_CONFIG_TARGET,
  OBSERVABILITY_SERVICES,
  PROFILE,
  PUBLISHED_HOST_PORTS,
  SERVICE,
} from "../src/render/compose-base";

/**
 * The renderer hard-codes facts about docker-compose.yml so it can work
 * from a published package with no compose file to hand. This suite is
 * what stops those facts going stale: it reads the real file and checks
 * every one of them.
 */
const REPO = join(__dirname, "..", "..", "..");

interface ComposeFile {
  services: Record<
    string,
    {
      profiles?: string[];
      ports?: string[];
      depends_on?: Record<string, { condition?: string }>;
      volumes?: string[];
      deploy?: { replicas?: number | string };
    }
  >;
}

const compose = parseYaml(readFileSync(join(REPO, COMPOSE_FILE), "utf8")) as ComposeFile;

describe("service names", () => {
  it("all exist in docker-compose.yml", () => {
    for (const name of Object.values(SERVICE)) {
      expect(Object.keys(compose.services)).toContain(name);
    }
  });

  it("names PAA as paa-1, not paa", () => {
    expect(SERVICE.paa).toBe("paa-1");
    expect(compose.services["paa"]).toBeUndefined();
  });
});

describe("the depends_on graph", () => {
  it("matches the compose file exactly, edge for edge", () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const [name, svc] of Object.entries(compose.services)) {
      if (!svc.depends_on) continue;
      const edges: Record<string, string> = {};
      for (const [dep, spec] of Object.entries(svc.depends_on)) {
        edges[dep] = spec.condition ?? "service_started";
      }
      actual[name] = edges;
    }

    // The table only needs the services whose blocks the renderer
    // rebuilds, which is every service that depends on a datastore.
    for (const [service, expected] of Object.entries(BASE_DEPENDS_ON)) {
      expect(actual[service]).toEqual(expected);
    }
  });

  it("covers every service that depends on a droppable datastore", () => {
    const droppable = new Set<string>([
      SERVICE.postgres,
      SERVICE.redis,
      SERVICE.kafka,
      SERVICE.zookeeper,
      ...OBSERVABILITY_SERVICES,
    ]);

    for (const [name, svc] of Object.entries(compose.services)) {
      if (!svc.depends_on) continue;
      const touchesDroppable = Object.keys(svc.depends_on).some((d) => droppable.has(d));
      if (touchesDroppable) {
        // If this fails, a new service depends on a datastore and the
        // renderer would leave it pointing at a service it removed.
        expect(Object.keys(BASE_DEPENDS_ON)).toContain(name);
      }
    }
  });
});

describe("published host ports", () => {
  it("matches the compose file for every service that publishes one", () => {
    for (const [name, ports] of Object.entries(PUBLISHED_HOST_PORTS)) {
      expect(compose.services[name]?.ports).toEqual(ports);
    }
  });

  it("records a port for every scalable service that publishes one", () => {
    // RDA publishes nothing, which is why it can scale behind NGINX
    // without special handling.
    expect(compose.services[SERVICE.rda]?.ports).toBeUndefined();
    expect(compose.services[SERVICE.sentinel]?.ports).toBeUndefined();
  });
});

describe("profiles", () => {
  it("matches the profiles the compose file declares", () => {
    expect(compose.services[SERVICE.fia]?.profiles).toEqual([PROFILE.fia]);
    expect(compose.services[SERVICE.mla]?.profiles).toEqual([PROFILE.mla]);
    expect(compose.services[SERVICE.sentinel]?.profiles).toEqual([PROFILE.sentinel]);
  });

  it("confirms Prometheus and Grafana carry no profile, so they must be removed rather than withheld", () => {
    for (const name of OBSERVABILITY_SERVICES) {
      expect(compose.services[name]?.profiles).toBeUndefined();
    }
  });

  it("confirms RDA and PAA carry no profile, since neither can be disabled", () => {
    expect(compose.services[SERVICE.rda]?.profiles).toBeUndefined();
    expect(compose.services[SERVICE.paa]?.profiles).toBeUndefined();
  });
});

describe("the nginx config mount", () => {
  it("is the path the renderer swaps", () => {
    expect(compose.services[SERVICE.nginx]?.volumes).toEqual([
      `${NGINX_CONFIG_DEFAULT}:${NGINX_CONFIG_TARGET}:ro`,
    ]);
  });

  it("has a Sentinel variant committed beside it", () => {
    const path = join(REPO, NGINX_CONFIG_SENTINEL.replace(/^\.\//, ""));
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  });
});

describe("compose files", () => {
  it("both exist at the paths the command builder names", () => {
    expect(readFileSync(join(REPO, COMPOSE_FILE), "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(join(REPO, COMPOSE_FILE_GHCR), "utf8").length).toBeGreaterThan(0);
  });

  it("confirms RDA scales through RDA_REPLICAS, so the renderer must not add a second mechanism", () => {
    expect(String(compose.services[SERVICE.rda]?.deploy?.replicas)).toContain("RDA_REPLICAS");
  });

  it("confirms PAA is pinned to one replica in the base file", () => {
    expect(compose.services[SERVICE.paa]?.deploy?.replicas).toBe(1);
  });
});
