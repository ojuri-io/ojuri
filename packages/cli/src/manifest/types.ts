/**
 * The manifest as it appears after YAML parsing and ${VAR} resolution.
 * Every field is optional: the schema decides what is required, and the
 * defaults below decide what an omitted field means.
 */
export type DatastoreMode = "bundled" | "external";

export interface ResourcesSpec {
  cpu?: string;
  memory?: string;
}

export interface RequiredServiceSpec {
  replicas?: number;
  image?: string;
  resources?: ResourcesSpec;
}

export interface OptionalServiceSpec extends RequiredServiceSpec {
  enabled?: boolean;
}

export interface ToggleServiceSpec {
  enabled?: boolean;
  image?: string;
  resources?: ResourcesSpec;
}

export interface Manifest {
  version?: number;
  release?: string;
  datastores?: {
    postgres?: { mode?: DatastoreMode; url?: string };
    redis?: { mode?: DatastoreMode; host?: string; port?: number; password?: string };
    kafka?: { mode?: DatastoreMode; brokers?: string };
  };
  services?: {
    rda?: RequiredServiceSpec;
    paa?: RequiredServiceSpec;
    mla?: OptionalServiceSpec;
    fia?: OptionalServiceSpec;
    sentinel?: ToggleServiceSpec;
  };
  auth?: {
    require_api_key?: boolean;
    jwt_secret?: string;
  };
  network?: {
    http_port?: number;
    public_url?: string;
  };
  observability?: {
    enabled?: boolean;
  };
}

/**
 * Defaults applied when a field is absent. These describe the stack a
 * plain `docker compose up` produces today, so an empty manifest and the
 * committed `ojuri.yaml` mean the same thing.
 */
export const DEFAULTS = {
  release: "v1",
  postgresMode: "bundled" as DatastoreMode,
  redisMode: "bundled" as DatastoreMode,
  kafkaMode: "bundled" as DatastoreMode,
  rdaReplicas: 3,
  paaReplicas: 1,
  mlaEnabled: false,
  mlaReplicas: 1,
  fiaEnabled: false,
  fiaReplicas: 1,
  sentinelEnabled: false,
  requireApiKey: false,
  httpPort: 80,
  publicUrl: "http://localhost",
  observabilityEnabled: true,
} as const;

/** Field-by-field view of the manifest with defaults filled in. */
export interface EffectiveConfig {
  release: string;
  postgres: { mode: DatastoreMode; url?: string };
  redis: { mode: DatastoreMode; host?: string; port?: number; password?: string };
  kafka: { mode: DatastoreMode; brokers?: string };
  rda: { replicas: number };
  paa: { replicas: number };
  mla: { enabled: boolean; replicas: number };
  fia: { enabled: boolean; replicas: number };
  sentinel: { enabled: boolean };
  requireApiKey: boolean;
  jwtSecret: string;
  httpPort: number;
  publicUrl: string;
  observabilityEnabled: boolean;
}

export function effective(m: Manifest): EffectiveConfig {
  const d = m.datastores ?? {};
  const s = m.services ?? {};
  return {
    release: m.release ?? DEFAULTS.release,
    postgres: { mode: d.postgres?.mode ?? DEFAULTS.postgresMode, url: d.postgres?.url },
    redis: {
      mode: d.redis?.mode ?? DEFAULTS.redisMode,
      host: d.redis?.host,
      port: d.redis?.port,
      password: d.redis?.password,
    },
    kafka: { mode: d.kafka?.mode ?? DEFAULTS.kafkaMode, brokers: d.kafka?.brokers },
    rda: { replicas: s.rda?.replicas ?? DEFAULTS.rdaReplicas },
    paa: { replicas: s.paa?.replicas ?? DEFAULTS.paaReplicas },
    mla: {
      enabled: s.mla?.enabled ?? DEFAULTS.mlaEnabled,
      replicas: s.mla?.replicas ?? DEFAULTS.mlaReplicas,
    },
    fia: {
      enabled: s.fia?.enabled ?? DEFAULTS.fiaEnabled,
      replicas: s.fia?.replicas ?? DEFAULTS.fiaReplicas,
    },
    sentinel: { enabled: s.sentinel?.enabled ?? DEFAULTS.sentinelEnabled },
    requireApiKey: m.auth?.require_api_key ?? DEFAULTS.requireApiKey,
    jwtSecret: m.auth?.jwt_secret ?? "",
    httpPort: m.network?.http_port ?? DEFAULTS.httpPort,
    publicUrl: stripTrailingSlash(m.network?.public_url ?? DEFAULTS.publicUrl),
    observabilityEnabled: m.observability?.enabled ?? DEFAULTS.observabilityEnabled,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
