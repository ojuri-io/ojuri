/**
 * Facts about docker-compose.yml that the renderer has to know in order
 * to override it correctly. They are duplicated here rather than parsed
 * at runtime so `ojuri render` works from a published package with no
 * compose file to hand, and `test/compose-base.spec.ts` pins every one
 * of them against the real file so they cannot drift.
 */

/** Compose service names. The PAA service is `paa-1`, not `paa`. */
export const SERVICE = {
  nginx: "nginx",
  sentinel: "sentinel",
  rda: "rda",
  paa: "paa-1",
  fia: "fia",
  mla: "mla",
  redis: "redis",
  zookeeper: "zookeeper",
  kafka: "kafka",
  postgres: "postgres",
  dbMigrate: "db-migrate",
  prometheus: "prometheus",
  grafana: "grafana",
} as const;

export type Condition = "service_healthy" | "service_started" | "service_completed_successfully";

/**
 * Every `depends_on` edge in the base file. Dropping a bundled datastore
 * means rewriting each dependant's block, because Compose refuses a
 * project whose depends_on names a service that is no longer defined,
 * and `!override` replaces the whole map rather than merging into it.
 */
export const BASE_DEPENDS_ON: Record<string, Record<string, Condition>> = {
  [SERVICE.rda]: {
    redis: "service_healthy",
    kafka: "service_healthy",
    postgres: "service_healthy",
    "db-migrate": "service_completed_successfully",
  },
  [SERVICE.paa]: {
    redis: "service_healthy",
    kafka: "service_healthy",
    postgres: "service_healthy",
    "db-migrate": "service_completed_successfully",
  },
  [SERVICE.fia]: {
    kafka: "service_healthy",
    postgres: "service_healthy",
  },
  [SERVICE.mla]: {
    kafka: "service_healthy",
    postgres: "service_healthy",
    "db-migrate": "service_completed_successfully",
  },
  [SERVICE.dbMigrate]: {
    postgres: "service_healthy",
  },
};

/** Services whose fixed host port cannot be published more than once. */
export const PUBLISHED_HOST_PORTS: Record<string, string[]> = {
  [SERVICE.paa]: ["9091:9090"],
  [SERVICE.fia]: ["9094:9094"],
  [SERVICE.mla]: ["9095:9095"],
};

/** Compose profiles in the base file. */
export const PROFILE = {
  fia: "fia",
  mla: "mla",
  sentinel: "sentinel",
  demo: "demo",
} as const;

/**
 * Prometheus and Grafana carry no profile, so they start on every
 * `docker compose up`. Switching observability off therefore has to
 * remove the services rather than simply withhold a profile.
 */
export const OBSERVABILITY_SERVICES = [SERVICE.prometheus, SERVICE.grafana];

/** The nginx config bind mount, and the opt-in variant that fronts Sentinel. */
export const NGINX_CONFIG_TARGET = "/etc/nginx/nginx.conf";
export const NGINX_CONFIG_DEFAULT = "./nginx/nginx.conf";
export const NGINX_CONFIG_SENTINEL = "./nginx/nginx.sentinel.conf";

/** Base compose files, in the order they must be passed to Compose. */
export const COMPOSE_FILE = "docker-compose.yml";
export const COMPOSE_FILE_GHCR = "docker-compose.ghcr.yml";
export const OVERLAY_FILENAME = "docker-compose.override.ojuri.yml";
export const ENV_FILENAME = ".env.rendered";
