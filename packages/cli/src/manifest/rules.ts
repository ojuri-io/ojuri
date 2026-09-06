import { warning, error, type Finding } from "../findings";
import { hasUnresolvedReference, lookup, type EnvSource } from "./env";
import { effective, type Manifest } from "./types";

/**
 * Semantic rules. The JSON Schema decides whether a manifest is
 * well-formed; these decide whether it describes a stack that will
 * actually work. Each rule is small and independent so a spec can pin
 * it by `code`.
 */
export function applyRules(manifest: Manifest, env: EnvSource): Finding[] {
  const cfg = effective(manifest);
  return [
    ...paaSingleton(cfg),
    ...mlaSingleton(cfg),
    ...fiaScaleOut(cfg),
    ...fiaFootprint(cfg),
    ...openPredictEndpoint(cfg, env),
    ...productionDefaults(cfg, env),
    ...externalDatastoreReferences(cfg),
    ...sentinelWithoutFia(cfg),
  ];
}

/** The CORS allowlist `ojuri render` will write into SENTINEL_CORS_ORIGINS. */
export function derivedCorsOrigins(publicUrl: string): string {
  return publicUrl;
}

type Config = ReturnType<typeof effective>;

function paaSingleton(cfg: Config): Finding[] {
  if (cfg.paa.replicas <= 1) return [];
  return [
    error(
      "paa-replicas",
      "services.paa.replicas",
      "PAA cannot run more than one replica.",
      "PAA holds the payment network in memory. A second copy joins the same " +
        "Kafka consumer group, takes half the partitions, and so builds its " +
        "graph from half the transactions. Both copies then run PageRank and " +
        "community detection over a partial picture, and a ring whose members " +
        "land on different partitions stops being visible to either one. " +
        "Nothing fails loudly; you simply stop catching those rings. " +
        "See paa-service/README.md. This is a known limitation of v1: PAA " +
        "scale-out is planned, not available."
    ),
  ];
}

function mlaSingleton(cfg: Config): Finding[] {
  if (!cfg.mla.enabled || cfg.mla.replicas <= 1) return [];
  return [
    error(
      "mla-replicas",
      "services.mla.replicas",
      "MLA cannot run more than one replica.",
      "MLA keeps its retrain cooldown and its in-progress flag in process " +
        "memory, and holds no leader lease, so each copy decides on its own " +
        "that it is time to retrain. Two copies can therefore train at once, " +
        "write over each other in the shared models/ mount, and register " +
        "competing versions with RDA. Run one."
    ),
  ];
}

function fiaScaleOut(cfg: Config): Finding[] {
  if (!cfg.fia.enabled || cfg.fia.replicas <= 1) return [];
  return [
    warning(
      "fia-replicas",
      "services.fia.replicas",
      `FIA is running ${cfg.fia.replicas} replicas. Check you have the memory for it.`,
      "This is safe: each replica owns whole Kafka partitions, so the retry " +
        "counters stay correct, and report writes are idempotent on " +
        "transactionId. The cost is memory. Each replica is capped at 16 GiB " +
        "and a loaded Phi-3 fills much of it, so budget roughly that much per " +
        "copy. The model weights are shared through one cache volume and are " +
        "downloaded once. Rendering will drop FIA's fixed host port, since " +
        "several replicas cannot publish 9094 at the same time; reach FIA " +
        "through NGINX at /fia/ instead."
    ),
  ];
}

function fiaFootprint(cfg: Config): Finding[] {
  if (!cfg.fia.enabled) return [];
  return [
    warning(
      "fia-enabled",
      "services.fia.enabled",
      "FIA needs roughly 10 GB of disk and 16 GB of free RAM.",
      "On first start it downloads about 7.6 GB of Phi-3 weights from " +
        "HuggingFace into a volume, so the first run is slow and needs " +
        "outbound network. To avoid the download, pre-stage a checkpoint and " +
        "point FIA_LLM_MODEL_PATH at it, or set FIA_DISABLE_LLM=true to skip " +
        "the model entirely and serve reports from the deterministic " +
        "rule-based path. Neither affects RDA: FIA is never on the " +
        "authorisation path."
    ),
  ];
}

function openPredictEndpoint(cfg: Config, env: EnvSource): Finding[] {
  if (cfg.requireApiKey) return [];
  // In production the same fact is an error from productionDefaults, and
  // saying it twice on one path just buries the stronger message.
  if (lookup(env, "NODE_ENV") === "production") return [];
  return [
    warning(
      "predict-unauthenticated",
      "auth.require_api_key",
      "POST /v1/predict accepts any caller that can reach it.",
      "This is the shipped default so a fresh checkout works without setup. " +
        "Do not expose the stack beyond your own host while it holds. Set " +
        "require_api_key: true and issue a key from POST /v1/admin/api-keys " +
        "before anything else can reach the port."
    ),
  ];
}

/**
 * Mirrors RDA's own `warnIfUnsafeDefaults()` in src/server.ts. RDA
 * refuses to boot when NODE_ENV=production and any of these three still
 * hold, unless ALLOW_UNSAFE_PROD_DEFAULTS=true. Reporting it here means
 * an operator finds out before the containers start rather than from a
 * crash loop. Outside production RDA warns, and so do we.
 */
function productionDefaults(cfg: Config, env: EnvSource): Finding[] {
  const isProduction = lookup(env, "NODE_ENV") === "production";
  const override = (lookup(env, "ALLOW_UNSAFE_PROD_DEFAULTS") ?? "").toLowerCase() === "true";

  const violations: Violation[] = [];

  if (!cfg.requireApiKey) {
    violations.push({
      code: "prod-api-key",
      path: "auth.require_api_key",
      summary: "RDA_REQUIRE_API_KEY is false, so POST /v1/predict is open.",
      detail:
        "Set require_api_key: true and issue keys via POST /v1/admin/api-keys " +
        "before exposing this beyond your own host.",
      // openPredictEndpoint already says this in non-production terms.
      duplicateOutsideProduction: true,
    });
  }

  if (hasUnresolvedReference(cfg.jwtSecret)) {
    violations.push({
      code: "prod-jwt-secret",
      path: "auth.jwt_secret",
      summary: "AUTH_JWT_SECRET is not set, so the JWT secret has nothing to resolve to.",
      detail:
        "The manifest refers to ${AUTH_JWT_SECRET}, but it is set neither in " +
        "the process environment nor in the .env file beside the manifest. " +
        "Copy .env.example to .env, or generate one with `openssl rand " +
        "-base64 48` and export it.",
    });
  } else if (cfg.jwtSecret.startsWith("dev-only-secret") || cfg.jwtSecret.length < 32) {
    violations.push({
      code: "prod-jwt-secret",
      path: "auth.jwt_secret",
      summary: "AUTH_JWT_SECRET is the development default, or shorter than 32 characters.",
      detail:
        "Generate a real secret, for example `openssl rand -base64 48`, and " +
        "set AUTH_JWT_SECRET before exposing this service.",
    });
  }

  const cors = derivedCorsOrigins(cfg.publicUrl);
  if (cors.length === 0 || cors.includes("localhost")) {
    violations.push({
      code: "prod-cors",
      path: "network.public_url",
      summary: "SENTINEL_CORS_ORIGINS would be empty or still pointing at localhost.",
      detail:
        "Rendering writes network.public_url into SENTINEL_CORS_ORIGINS. Set " +
        "it to the origin the dashboard is served from, for example " +
        "https://sentinel.example.com",
    });
  }

  if (violations.length === 0) return [];

  // Outside production these are advisory, exactly as RDA treats them.
  if (!isProduction) {
    return violations
      .filter((v) => !v.duplicateOutsideProduction)
      .map((v) => warning(v.code, v.path, v.summary, v.detail));
  }

  if (override) {
    return violations.map((v) =>
      warning(
        v.code,
        v.path,
        v.summary,
        `${v.detail} ALLOW_UNSAFE_PROD_DEFAULTS=true is set, so RDA will boot anyway.`
      )
    );
  }

  return violations.map((v) =>
    error(
      v.code,
      v.path,
      v.summary,
      `${v.detail} RDA refuses to boot with NODE_ENV=production while this ` +
        "holds, so the stack would come up without it. Set " +
        "ALLOW_UNSAFE_PROD_DEFAULTS=true to override, and only on a private " +
        "network where the dashboard's own auth is enough."
    )
  );
}

interface Violation {
  code: string;
  path: string;
  summary: string;
  detail: string;
  /** Reported by another rule already when NODE_ENV is not production. */
  duplicateOutsideProduction?: boolean;
}

/**
 * An external datastore whose connection details never resolved would
 * render a compose file pointing at the literal text `${DB_URL}`, so
 * this is an error rather than a warning.
 */
function externalDatastoreReferences(cfg: Config): Finding[] {
  const findings: Finding[] = [];

  const required: Array<{ path: string; value: string | undefined }> = [];
  if (cfg.postgres.mode === "external") {
    required.push({ path: "datastores.postgres.url", value: cfg.postgres.url });
  }
  if (cfg.redis.mode === "external") {
    required.push({ path: "datastores.redis.host", value: cfg.redis.host });
  }
  if (cfg.kafka.mode === "external") {
    required.push({ path: "datastores.kafka.brokers", value: cfg.kafka.brokers });
  }

  for (const field of required) {
    for (const name of unresolvedNames(field.value)) {
      findings.push(
        error(
          "unresolved-reference",
          field.path,
          `${name} is not set, so this required field has nothing to resolve to.`,
          `The manifest refers to \${${name}}, but it is set neither in the ` +
            `process environment nor in the .env file beside the manifest. ` +
            `Export it, or write the value into .env, or put a literal value ` +
            `in the manifest.`
        )
      );
    }
  }

  // Optional external fields are worth a warning: the stack will still
  // start, just without the value the operator meant to supply.
  const optional: Array<{ path: string; value: string | undefined }> =
    cfg.redis.mode === "external" ? [{ path: "datastores.redis.password", value: cfg.redis.password }] : [];

  for (const field of optional) {
    for (const name of unresolvedNames(field.value)) {
      findings.push(
        warning(
          "unresolved-reference-optional",
          field.path,
          `${name} is not set, so this field will be left empty.`,
          `The manifest refers to \${${name}} but nothing supplies it. That is ` +
            `fine when the external Redis takes no password; set it otherwise.`
        )
      );
    }
  }

  return findings;
}

function unresolvedNames(value: string | undefined): string[] {
  if (!hasUnresolvedReference(value)) return [];
  const names: string[] = [];
  for (const match of (value as string).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function sentinelWithoutFia(cfg: Config): Finding[] {
  if (!cfg.sentinel.enabled || cfg.fia.enabled) return [];
  return [
    warning(
      "sentinel-without-fia",
      "services.fia.enabled",
      "Sentinel is enabled but FIA is not, so its investigation pages will show FIA as unavailable.",
      "Nothing breaks: the dashboard's reads fall back to empty and the " +
        "affected pages render an empty state. Enable FIA if you want " +
        "investigation reports, having read the footprint warning first."
    ),
  ];
}
