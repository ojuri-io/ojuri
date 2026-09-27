import { derivedCorsOrigins } from "../manifest/cors";
import { effective, type EffectiveConfig, type Manifest } from "../manifest/types";
import {
  BASE_DEPENDS_ON,
  NGINX_CONFIG_SENTINEL,
  NGINX_CONFIG_TARGET,
  OBSERVABILITY_SERVICES,
  PROFILE,
  PUBLISHED_HOST_PORTS,
  SERVICE,
} from "./compose-base";

/**
 * Everything the manifest implies about the stack, worked out once. The
 * `.env` fragment, the Compose overlay and the printed command are all
 * derived from this object, so they cannot describe different stacks.
 */
export interface RenderPlan {
  cfg: EffectiveConfig;
  /** Values written to `.env.rendered`, which Compose substitutes. */
  env: Record<string, string>;
  /** Compose profiles to activate. */
  profiles: string[];
  /** Bundled services the overlay removes. */
  dropped: string[];
  /** The overlay document, ready to serialise. */
  overlay: ComposeOverlay;
}

export interface ComposeOverlay {
  services: Record<string, ComposeServiceOverride>;
}

export interface ComposeServiceOverride {
  reset?: true;
  environment?: Record<string, string>;
  dependsOn?: Record<string, string> | null;
  replicas?: number;
  resetPorts?: true;
  ports?: string[];
  volumes?: string[];
  image?: string;
  resources?: { cpu?: string; memory?: string };
}

export function buildPlan(manifest: Manifest): RenderPlan {
  const cfg = effective(manifest);
  const services: Record<string, ComposeServiceOverride> = {};

  const dropped = droppedServices(cfg);
  for (const name of dropped) {
    override(services, name).reset = true;
  }

  applyExternalPostgres(cfg, services);
  applyExternalRedis(cfg, services);
  applyExternalKafka(cfg, services);
  applyDependsOn(dropped, services);
  applyReplicas(cfg, services);
  applyPerServiceOverrides(manifest, services);
  applyNginx(cfg, services);

  return {
    cfg,
    env: buildEnv(cfg),
    profiles: buildProfiles(cfg),
    dropped,
    overlay: { services },
  };
}

/** Variables Compose substitutes, and their values under this manifest. */
function buildEnv(cfg: EffectiveConfig): Record<string, string> {
  const env: Record<string, string> = {
    OJURI_VERSION: cfg.release,
    RDA_REPLICAS: String(cfg.rda.replicas),
    RDA_REQUIRE_API_KEY: String(cfg.requireApiKey),
    SENTINEL_CORS_ORIGINS: derivedCorsOrigins(cfg.publicUrl),
  };

  // With MLA in Compose the RDA replicas should probe the in-compose
  // service rather than host.docker.internal, which is what the base
  // file assumes. Left alone when MLA is off, so the default stack is
  // untouched.
  if (cfg.mla.enabled) {
    env.MLA_HEALTH_URL = "http://mla:9095";
  }

  return env;
}

function buildProfiles(cfg: EffectiveConfig): string[] {
  const profiles: string[] = [];
  if (cfg.mla.enabled) profiles.push(PROFILE.mla);
  if (cfg.fia.enabled) profiles.push(PROFILE.fia);
  if (cfg.sentinel.enabled) profiles.push(PROFILE.sentinel);
  return profiles;
}

function droppedServices(cfg: EffectiveConfig): string[] {
  const dropped: string[] = [];
  if (cfg.postgres.mode === "external") dropped.push(SERVICE.postgres);
  if (cfg.redis.mode === "external") dropped.push(SERVICE.redis);
  if (cfg.kafka.mode === "external") {
    // Zookeeper exists only to serve the bundled broker, and Kafka
    // depends on it, so the two leave together or not at all.
    dropped.push(SERVICE.kafka, SERVICE.zookeeper);
  }
  if (!cfg.observabilityEnabled) dropped.push(...OBSERVABILITY_SERVICES);
  return dropped;
}

/**
 * Compose rejects a project whose depends_on names a service that is no
 * longer defined, and `!override` replaces the whole map rather than
 * merging into it, so each dependant's block is rebuilt from the base
 * graph minus whatever left.
 */
function applyDependsOn(dropped: string[], services: Record<string, ComposeServiceOverride>): void {
  if (dropped.length === 0) return;
  const gone = new Set(dropped);

  for (const [service, deps] of Object.entries(BASE_DEPENDS_ON)) {
    if (gone.has(service)) continue;
    const remaining = Object.entries(deps).filter(([name]) => !gone.has(name));
    if (remaining.length === Object.keys(deps).length) continue;

    override(services, service).dependsOn =
      remaining.length === 0 ? null : Object.fromEntries(remaining);
  }
}

function applyExternalPostgres(
  cfg: EffectiveConfig,
  services: Record<string, ComposeServiceOverride>
): void {
  if (cfg.postgres.mode !== "external" || !cfg.postgres.url) return;
  const url = cfg.postgres.url;
  const parts = parsePostgresUrl(url);

  // The compose file hardcodes `postgres` as the hostname in every one
  // of these, so nothing in .env can redirect them; they have to be
  // overridden per service.
  Object.assign(mkEnv(services, SERVICE.rda), {
    DB_URL: url,
    DB_HOST: parts.host,
    DB_PORT: parts.port,
    DB_DATABASE: parts.database,
    DB_USERNAME: parts.username,
    DB_PASSWORD: parts.password,
  });
  Object.assign(mkEnv(services, SERVICE.paa), { DB_URL: url });
  Object.assign(mkEnv(services, SERVICE.dbMigrate), {
    DB_HOST: parts.host,
    DB_PORT: parts.port,
    DB_DATABASE: parts.database,
    DB_USERNAME: parts.username,
    DB_PASSWORD: parts.password,
  });

  const pythonEnv = {
    POSTGRES_HOST: parts.host,
    POSTGRES_PORT: parts.port,
    POSTGRES_DB: parts.database,
    POSTGRES_USER: parts.username,
    POSTGRES_PASSWORD: parts.password,
  };
  if (cfg.fia.enabled) Object.assign(mkEnv(services, SERVICE.fia), pythonEnv);
  if (cfg.mla.enabled) Object.assign(mkEnv(services, SERVICE.mla), pythonEnv);
}

function applyExternalRedis(
  cfg: EffectiveConfig,
  services: Record<string, ComposeServiceOverride>
): void {
  if (cfg.redis.mode !== "external" || !cfg.redis.host) return;
  const redisEnv: Record<string, string> = {
    REDIS_HOST: cfg.redis.host,
    REDIS_PORT: String(cfg.redis.port ?? 6379),
  };
  if (cfg.redis.password !== undefined) redisEnv.REDIS_PASSWORD = cfg.redis.password;

  Object.assign(mkEnv(services, SERVICE.rda), redisEnv);
  Object.assign(mkEnv(services, SERVICE.paa), redisEnv);
}

function applyExternalKafka(
  cfg: EffectiveConfig,
  services: Record<string, ComposeServiceOverride>
): void {
  if (cfg.kafka.mode !== "external" || !cfg.kafka.brokers) return;
  const brokers = { KAFKA_BROKERS: cfg.kafka.brokers };

  Object.assign(mkEnv(services, SERVICE.rda), brokers);
  Object.assign(mkEnv(services, SERVICE.paa), brokers);
  if (cfg.fia.enabled) Object.assign(mkEnv(services, SERVICE.fia), brokers);
  if (cfg.mla.enabled) Object.assign(mkEnv(services, SERVICE.mla), brokers);
}

/**
 * RDA scales through RDA_REPLICAS, which stays the only mechanism for
 * it. The others carry a literal `replicas: 1` in the base file, so
 * anything above that needs an override, and a service with a fixed
 * host port loses it: the same port cannot be published twice.
 */
function applyReplicas(
  cfg: EffectiveConfig,
  services: Record<string, ComposeServiceOverride>
): void {
  const scaled: Array<{ name: string; replicas: number; enabled: boolean }> = [
    { name: SERVICE.paa, replicas: cfg.paa.replicas, enabled: true },
    { name: SERVICE.mla, replicas: cfg.mla.replicas, enabled: cfg.mla.enabled },
    { name: SERVICE.fia, replicas: cfg.fia.replicas, enabled: cfg.fia.enabled },
  ];

  for (const service of scaled) {
    if (!service.enabled || service.replicas <= 1) continue;
    const entry = override(services, service.name);
    entry.replicas = service.replicas;
    if (PUBLISHED_HOST_PORTS[service.name]) entry.resetPorts = true;
  }
}

/** Optional per-service image and resource overrides from the manifest. */
function applyPerServiceOverrides(
  manifest: Manifest,
  services: Record<string, ComposeServiceOverride>
): void {
  const mapping: Array<[string, { image?: string; resources?: { cpu?: string; memory?: string } }?]> =
    [
      [SERVICE.rda, manifest.services?.rda],
      [SERVICE.paa, manifest.services?.paa],
      [SERVICE.mla, manifest.services?.mla],
      [SERVICE.fia, manifest.services?.fia],
      [SERVICE.sentinel, manifest.services?.sentinel],
    ];

  for (const [name, spec] of mapping) {
    if (!spec) continue;
    if (spec.image !== undefined) override(services, name).image = spec.image;
    if (spec.resources !== undefined) override(services, name).resources = spec.resources;
  }
}

/**
 * The shipped nginx.conf routes `/` to RDA, so enabling the Sentinel
 * profile on its own starts a container nothing reaches. Swapping the
 * config bind mount for the Sentinel variant is what wires it up.
 */
function applyNginx(cfg: EffectiveConfig, services: Record<string, ComposeServiceOverride>): void {
  if (cfg.sentinel.enabled) {
    override(services, SERVICE.nginx).volumes = [
      `${NGINX_CONFIG_SENTINEL}:${NGINX_CONFIG_TARGET}:ro`,
    ];
  }
  if (cfg.httpPort !== 80) {
    override(services, SERVICE.nginx).ports = [`${cfg.httpPort}:80`];
  }
}

function override(
  services: Record<string, ComposeServiceOverride>,
  name: string
): ComposeServiceOverride {
  const existing = services[name];
  if (existing) return existing;
  const created: ComposeServiceOverride = {};
  services[name] = created;
  return created;
}

function mkEnv(
  services: Record<string, ComposeServiceOverride>,
  name: string
): Record<string, string> {
  const entry = override(services, name);
  if (!entry.environment) entry.environment = {};
  return entry.environment;
}

export interface PostgresUrlParts {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

/**
 * Split a connection URL into the discrete DB_* and POSTGRES_* values
 * the services read. Falls back to the compose defaults for anything
 * the URL leaves out.
 */
export function parsePostgresUrl(url: string): PostgresUrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: "postgres", port: "5432", database: "fraud_db", username: "postgres", password: "" };
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "fraud_db";
  return {
    host: parsed.hostname || "postgres",
    port: parsed.port || "5432",
    database,
    username: decodeURIComponent(parsed.username) || "postgres",
    password: decodeURIComponent(parsed.password),
  };
}
