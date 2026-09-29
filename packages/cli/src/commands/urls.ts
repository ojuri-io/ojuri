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

/**
 * Services published straight onto the host rather than proxied through
 * NGINX. They take public_url's hostname and scheme but their own port:
 * hardcoding localhost sent an operator on a remote box to their own
 * machine.
 */
const HOST_PORT = { grafana: 3001, paa: 9091, mla: 9095, fia: 9094 } as const;

function hostUrl(cfg: EffectiveConfig, port: number, path = "/"): string {
  const url = new URL(cfg.publicUrl);
  url.port = String(port);
  url.pathname = path;
  return stripTrailingSlash(url.toString());
}

function grafanaUrl(cfg: EffectiveConfig): string {
  return hostUrl(cfg, HOST_PORT.grafana);
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
  if (cfg.observabilityEnabled) urls.grafana = grafanaUrl(cfg);
  return urls;
}

export interface SummaryLink {
  label: string;
  url: string;
  note: string;
}

/**
 * The table `ojuri up` prints once the stack is answering, in the order
 * an operator wants it: the dashboard they will live in, the endpoint
 * their payment system calls, then the services behind both.
 */
export function summaryLinks(cfg: EffectiveConfig): SummaryLink[] {
  const base = baseUrl(cfg);
  const links: SummaryLink[] = [];

  if (cfg.sentinel.enabled) {
    links.push({ label: "Sentinel", url: base, note: "operator dashboard" });
  }
  links.push({ label: "Predict", url: `${base}/v1/predict`, note: "score a transaction" });
  if (cfg.observabilityEnabled) {
    links.push({ label: "Grafana", url: grafanaUrl(cfg), note: "metrics dashboards" });
  }
  links.push({
    label: "PAA",
    url: hostUrl(cfg, HOST_PORT.paa, "/stats"),
    note: "graph and velocity state",
  });
  if (cfg.mla.enabled) {
    links.push({
      label: "MLA",
      url: hostUrl(cfg, HOST_PORT.mla, "/stats"),
      note: "drift and retrain status",
    });
  }
  if (cfg.fia.enabled) {
    // Several replicas cannot publish 9094 between them, so rendering
    // drops the host port and NGINX is the only way in.
    const url =
      cfg.fia.replicas > 1 ? `${base}/fia/stats` : hostUrl(cfg, HOST_PORT.fia, "/stats");
    links.push({ label: "FIA", url, note: "investigation reports" });
  }

  return links;
}
