import { lookup, type EnvSource } from "../manifest/env";
import type { EffectiveConfig } from "../manifest/types";

/**
 * Where to probe each service.
 *
 * In the shipped stack everything is behind NGINX, so that is tried
 * first: RDA at `/ready`, FIA and MLA through their proxied prefixes.
 * The direct host ports are the fallback, which covers running a
 * service natively while the rest is in Compose. `demo-traffic.mjs`
 * already probes both, and this follows it.
 *
 * The `*_HEALTH_URL` variables are honoured only when actually set.
 * They are commented out in `.env.example` and describe host-side runs,
 * so treating a commented example as configuration would point every
 * probe at a port nothing is listening on.
 */
export interface ServiceProbeTargets {
  name: string;
  /** Tried in order; the first that answers wins. */
  urls: string[];
}

export function baseUrl(cfg: EffectiveConfig): string {
  const url = new URL(cfg.publicUrl);
  // An explicit port in public_url wins: the operator has said where
  // the stack actually answers. Otherwise add http_port unless it is
  // the scheme's default, which would render as a redundant :80.
  if (url.port === "" && !isDefaultPort(url.protocol, cfg.httpPort)) {
    url.port = String(cfg.httpPort);
  }
  return stripTrailingSlash(url.toString());
}

function isDefaultPort(protocol: string, port: number): boolean {
  return (protocol === "http:" && port === 80) || (protocol === "https:" && port === 443);
}

export function probeTargets(cfg: EffectiveConfig, env: EnvSource): ServiceProbeTargets[] {
  const base = baseUrl(cfg);
  const targets: ServiceProbeTargets[] = [
    { name: "rda", urls: override(env, "RDA_HEALTH_URL") ?? [`${base}/ready`, "http://localhost:3000/readyz"] },
    { name: "paa", urls: override(env, "PAA_HEALTH_URL") ?? ["http://localhost:9091/readyz"] },
  ];

  if (cfg.fia.enabled) {
    targets.push({
      name: "fia",
      urls: override(env, "FIA_HEALTH_URL") ?? [`${base}/fia/readyz`, "http://localhost:9094/readyz"],
    });
  }
  if (cfg.mla.enabled) {
    targets.push({
      name: "mla",
      urls: override(env, "MLA_HEALTH_URL") ?? [`${base}/mla/readyz`, "http://localhost:9095/readyz"],
    });
  }
  return targets;
}

/**
 * An explicitly set `*_HEALTH_URL` replaces the probe list entirely.
 * A variable that is absent, or set to the empty string, is not a
 * configured value: empty is how the compose file says "MLA is
 * deliberately off", and a commented line in .env.example is not set at
 * all.
 */
function override(env: EnvSource, variable: string): string[] | null {
  const value = lookup(env, variable);
  if (value === undefined || value.trim() === "") return null;
  return [`${stripTrailingSlash(value)}/readyz`];
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** URLs `ojuri up` prints once the stack is answering. */
export function summaryUrls(cfg: EffectiveConfig): {
  predict: string;
  sentinel?: string;
  grafana?: string;
} {
  const base = baseUrl(cfg);
  const urls: { predict: string; sentinel?: string; grafana?: string } = {
    predict: `${base}/v1/predict`,
  };
  // Sentinel is served through NGINX at the root, not on a host port of
  // its own; 3001 is Grafana's.
  if (cfg.sentinel.enabled) urls.sentinel = base;
  if (cfg.observabilityEnabled) urls.grafana = "http://localhost:3001";
  return urls;
}
