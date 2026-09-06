import { connect, createServer } from "node:net";
import { statfs, totalmem } from "./system";
import { error, warning, type Finding } from "../findings";
import type { Exec } from "../exec";
import type { EffectiveConfig } from "../manifest/types";
import { parsePostgresUrl } from "../render/plan";

/** README's stated minimums. The Compose floor is real: `!reset` needs 2.24. */
export const MIN_DOCKER = "20.10";
export const MIN_COMPOSE = "2.24";

/** FIA's own requirements, from .env.example and the README. */
export const FIA_DISK_GB = 10;
export const FIA_RAM_GB = 16;

export interface DoctorDeps {
  exec: Exec;
  /** Returns null when the port is free, or a reason when it is taken. */
  checkPort?: (port: number) => Promise<string | null>;
  checkTcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  totalMemoryBytes?: () => number;
  freeDiskBytes?: (path: string) => number | null;
}

export async function doctor(cfg: EffectiveConfig, deps: DoctorDeps): Promise<Finding[]> {
  return [
    ...versionFindings(deps.exec),
    ...(await portFindings(cfg, deps.checkPort ?? isPortTaken)),
    ...(await datastoreFindings(cfg, deps.checkTcp ?? tcpReachable)),
    ...fiaFindings(cfg, deps),
  ];
}

function versionFindings(exec: Exec): Finding[] {
  const findings: Finding[] = [];

  const docker = exec.run(["docker", "--version"]);
  if (docker.status !== 0) {
    findings.push(
      error("docker-missing", "", "Docker is not installed, or not on PATH.", docker.stderr.trim())
    );
  } else {
    const version = firstVersion(docker.stdout);
    if (version && compareVersions(version, MIN_DOCKER) < 0) {
      findings.push(
        error(
          "docker-old",
          "",
          `Docker ${version} is older than the ${MIN_DOCKER} minimum.`,
          "See the requirements in README.md."
        )
      );
    }
  }

  const compose = exec.run(["docker", "compose", "version"]);
  if (compose.status !== 0) {
    findings.push(
      error(
        "compose-missing",
        "",
        "Docker Compose v2 is not available.",
        "`docker compose version` failed. The older `docker-compose` script is not enough."
      )
    );
    return findings;
  }

  const version = firstVersion(compose.stdout);
  if (version && compareVersions(version, MIN_COMPOSE) < 0) {
    findings.push(
      error(
        "compose-old",
        "",
        `Docker Compose ${version} is older than the ${MIN_COMPOSE} minimum.`,
        "The rendered overlay uses `!reset` and `!override`, which 2.24 " +
          "introduced. On an older Compose, use the build-from-source path in " +
          "README.md instead."
      )
    );
  }

  return findings;
}

/** Host ports the stack will publish under this manifest. */
export function requiredPorts(cfg: EffectiveConfig): Array<{ port: number; who: string }> {
  const ports: Array<{ port: number; who: string }> = [{ port: cfg.httpPort, who: "NGINX" }];

  if (cfg.postgres.mode === "bundled") ports.push({ port: 5433, who: "Postgres" });
  if (cfg.redis.mode === "bundled") ports.push({ port: 6380, who: "Redis" });
  if (cfg.kafka.mode === "bundled") {
    ports.push({ port: 9092, who: "Kafka (external listener)" });
    ports.push({ port: 29092, who: "Kafka (internal listener)" });
  }
  ports.push({ port: 9091, who: "PAA metrics" });
  if (cfg.observabilityEnabled) {
    ports.push({ port: 9090, who: "Prometheus" });
    ports.push({ port: 3001, who: "Grafana" });
  }
  // A scaled FIA gives up its published port, so it needs nothing free.
  if (cfg.fia.enabled && cfg.fia.replicas === 1) ports.push({ port: 9094, who: "FIA" });
  if (cfg.mla.enabled) ports.push({ port: 9095, who: "MLA" });

  return ports;
}

async function portFindings(
  cfg: EffectiveConfig,
  check: (port: number) => Promise<string | null>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { port, who } of requiredPorts(cfg)) {
    const taken = await check(port);
    if (taken) {
      findings.push(
        error(
          "port-taken",
          "",
          `Port ${port} is already in use, and ${who} needs it.`,
          `Stop whatever is holding it, or change the port. ${taken}`
        )
      );
    }
  }
  return findings;
}

async function datastoreFindings(
  cfg: EffectiveConfig,
  check: (host: string, port: number, timeoutMs: number) => Promise<boolean>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const targets: Array<{ label: string; host: string; port: number }> = [];

  if (cfg.postgres.mode === "external" && cfg.postgres.url) {
    const parts = parsePostgresUrl(cfg.postgres.url);
    targets.push({ label: "Postgres", host: parts.host, port: Number(parts.port) });
  }
  if (cfg.redis.mode === "external" && cfg.redis.host) {
    targets.push({ label: "Redis", host: cfg.redis.host, port: cfg.redis.port ?? 6379 });
  }
  if (cfg.kafka.mode === "external" && cfg.kafka.brokers) {
    const first = cfg.kafka.brokers.split(",")[0]?.trim() ?? "";
    const [host, port] = splitHostPort(first);
    if (host) targets.push({ label: "Kafka", host, port });
  }

  for (const target of targets) {
    const reachable = await check(target.host, target.port, 3000);
    if (!reachable) {
      findings.push(
        error(
          "datastore-unreachable",
          "",
          `${target.label} at ${target.host}:${target.port} did not accept a connection.`,
          "The manifest configures it as external, so the stack will not " +
            "start its own. Check the host, the port, and anything between."
        )
      );
    }
  }
  return findings;
}

function fiaFindings(cfg: EffectiveConfig, deps: DoctorDeps): Finding[] {
  if (!cfg.fia.enabled) return [];
  const findings: Finding[] = [];

  const totalRam = (deps.totalMemoryBytes ?? totalmem)();
  const ramGb = totalRam / 1024 ** 3;
  const neededRam = FIA_RAM_GB * cfg.fia.replicas;
  if (ramGb < neededRam) {
    findings.push(
      warning(
        "fia-ram",
        "services.fia",
        `FIA wants about ${neededRam} GB of RAM and this host has ${ramGb.toFixed(1)} GB.`,
        cfg.fia.replicas > 1
          ? `That is ${FIA_RAM_GB} GB per replica across ${cfg.fia.replicas} replicas. ` +
            "Reduce the count, or set FIA_DISABLE_LLM=true to serve reports from " +
            "the rule-based path instead."
          : "Set FIA_DISABLE_LLM=true to skip the model load entirely, or " +
            "pre-stage a smaller checkpoint via FIA_LLM_MODEL_PATH."
      )
    );
  }

  const free = (deps.freeDiskBytes ?? statfs)(process.cwd());
  if (free !== null && free / 1024 ** 3 < FIA_DISK_GB) {
    findings.push(
      warning(
        "fia-disk",
        "services.fia",
        `FIA needs about ${FIA_DISK_GB} GB free and this host has ${(free / 1024 ** 3).toFixed(1)} GB.`,
        "The Phi-3 weights are roughly 7.6 GB, downloaded on first start into " +
          "the fia-hf-cache volume."
      )
    );
  }

  return findings;
}

/** Binds the port briefly. Free means nothing was listening. */
export function isPortTaken(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" ? "Something is already listening." : String(err.message));
    });
    server.once("listening", () => server.close(() => resolve(null)));
    server.listen(port, "0.0.0.0");
  });
}

export function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function firstVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? match[0] : null;
}

/** Numeric comparison, so 2.9 sorts below 2.24 rather than above it. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const right = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function splitHostPort(value: string): [string, number] {
  const index = value.lastIndexOf(":");
  if (index === -1) return [value, 9092];
  return [value.slice(0, index), Number.parseInt(value.slice(index + 1), 10) || 9092];
}
