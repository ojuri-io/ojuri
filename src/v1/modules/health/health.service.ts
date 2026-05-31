import { FastifyReply, FastifyRequest } from "fastify";
import { container, injectable } from "tsyringe";
import Redis from "ioredis";
import httpStatus from "http-status";
import { Kafka, logLevel } from "kafkajs";
import RedisClient from "@shared/redis-client/redis-client";
import OnnxService from "@shared/onnx/onnx.service";
import appConfig from "@config/app.config";
import { getKnexInstance } from "../../../database";

const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 1000;

interface ServiceProbeTarget {
  name: string;
  description: string;
  url: string | null;
}

// Defaults use 127.0.0.1 rather than `localhost` because Node's
// global fetch resolves `localhost` to ::1 on macOS; Fastify binds to
// the IPv4 loopback by default, so the IPv6 dial gets ECONNREFUSED.
// Operators can override per-service via the env vars below.
const buildServiceTargets = (): ServiceProbeTarget[] => [
  {
    name: "RDA",
    description: "Real-Time Detection Agent · TS/Fastify",
    // Self-loop: RDA pings its own readiness endpoint so the dashboard
    // surfaces the same UP/DOWN signal an external orchestrator would.
    url: process.env.RDA_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
  },
  {
    name: "PAA",
    description: "Pattern Analysis Agent · TS Kafka consumer",
    // PAA listens on 9090 inside its container but docker-compose maps it
    // to host port 9091 (see docker-compose.yml). Override with
    // PAA_HEALTH_URL when running PAA natively without the mapping.
    url: process.env.PAA_HEALTH_URL || "http://127.0.0.1:9091",
  },
  {
    name: "MLA",
    description: "Model Learning Agent · Python drift/retrain",
    // MLA runs natively on the developer's host (not in compose by
    // design — it owns large model artefacts on disk). Default to
    // 127.0.0.1:9095; set MLA_HEALTH_URL='' to skip the probe.
    url: process.env.MLA_HEALTH_URL ?? "http://127.0.0.1:9095",
  },
  {
    name: "FIA",
    description: "Fraud Investigation Agent · Python Phi-3",
    url: process.env.FIA_HEALTH_URL || "http://127.0.0.1:9094",
  },
];

@injectable()
class HealthService {
  private redisClient: Redis;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient.get();
  }

  async readinessCheck(req: FastifyRequest, reply: FastifyReply) {
    const postgresHealth = await this.checkPostgresHealth();
    const redisHealth = await this.checkRedisHealth();
    const modelHealth = this.checkModelHealth();

    const allUp =
      postgresHealth.status === "UP" &&
      redisHealth.status === "OK" &&
      modelHealth.status === "UP";

    if (allUp) {
      reply.code(httpStatus.OK).send({
        status: "UP",
        checks: [postgresHealth, redisHealth, modelHealth],
      });
    } else {
      reply.code(httpStatus.SERVICE_UNAVAILABLE).send({
        status: "DOWN",
        checks: [postgresHealth, redisHealth, modelHealth],
      });
    }
  }

  /**
   * Inline check (no awaits) — OnnxService records its calibration
   * status synchronously at init time. If a model is loaded but
   * calibration failed (constant output / mockInference fallback /
   * non-deterministic output) this returns DOWN so the orchestrator
   * pulls traffic instead of routing it to a broken predictor.
   */
  private checkModelHealth(): { name: string; status: "UP" | "DOWN" } {
    try {
      const onnxService = container.resolve(OnnxService);
      return {
        name: "onnx-model",
        status: onnxService.isReady() ? "UP" : "DOWN",
      };
    } catch {
      return { name: "onnx-model", status: "DOWN" };
    }
  }

  livelinessCheck(req: FastifyRequest, reply: FastifyReply) {
    reply.code(httpStatus.OK).send({
      status: "UP",
    });
  }

  /**
   * Fan out a 1 s readiness probe to every configured service URL.
   * Used by the dashboard's Service Health page. Targets without a
   * URL (e.g. MLA — typically not exposing HTTP) come back as
   * UNKNOWN rather than DOWN so the UI can distinguish "we didn't
   * try" from "we tried and it failed".
   */
  async serviceProbes(): Promise<Array<{
    name: string;
    description: string;
    status: "UP" | "DOWN" | "DEGRADED" | "UNKNOWN";
    url: string | null;
    latencyMs: number | null;
    when: string;
    kvs: Array<{ k: string; v: string; tone?: "success" | "warning" | "danger" }>;
  }>> {
    const targets = buildServiceTargets();
    const results = await Promise.all(
      targets.map(async (t) => {
        const when = new Date().toISOString();
        if (!t.url) {
          return {
            name: t.name,
            description: t.description,
            status: "UNKNOWN" as const,
            url: null,
            latencyMs: null,
            when,
            kvs: [{ k: "ENDPOINT", v: "not configured" }],
          };
        }
        const probeUrl = t.url.replace(/\/$/, "") + "/readyz";
        const started = Date.now();
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
        try {
          const res = await fetch(probeUrl, { signal: ac.signal });
          const latencyMs = Date.now() - started;
          let status: "UP" | "DOWN" | "DEGRADED" = res.ok ? "UP" : "DEGRADED";
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* readiness probe might return non-JSON; tolerate */
          }
          // RDA's /readyz nests `{ status }` at the top level; PAA / FIA
          // copy that shape. Anything non-UP → DEGRADED.
          if (body && typeof body === "object" && (body as { status?: string }).status) {
            const reported = String((body as { status: string }).status).toUpperCase();
            if (reported !== "UP" && reported !== "OK") status = "DEGRADED";
          }
          return {
            name: t.name,
            description: t.description,
            status,
            url: t.url,
            latencyMs,
            when,
            kvs: [
              { k: "LATENCY", v: `${latencyMs}ms` },
              { k: "ENDPOINT", v: probeUrl },
            ],
          };
        } catch (err) {
          return {
            name: t.name,
            description: t.description,
            status: "DOWN" as const,
            url: t.url,
            latencyMs: null,
            when,
            kvs: [
              { k: "ENDPOINT", v: probeUrl },
              { k: "ERROR", v: err instanceof Error ? err.message : "probe failed", tone: "danger" as const },
            ],
          };
        } finally {
          clearTimeout(to);
        }
      })
    );
    return results;
  }

  /**
   * Pings Postgres, Redis and Kafka and returns a card per
   * dependency. Each probe runs with the same 1 s budget so the
   * page loads predictably even when one piece is offline.
   */
  async infraProbes() {
    const [pg, redis, kafka] = await Promise.all([
      this.probePostgres(),
      this.probeRedis(),
      this.probeKafka(),
    ]);
    return [pg, redis, kafka];
  }

  private async probePostgres() {
    const started = Date.now();
    try {
      const res = await getKnexInstance("primary").raw("SELECT 1 as ok");
      const ok = res?.rows?.[0]?.ok === 1;
      const latencyMs = Date.now() - started;
      return {
        name: "Postgres",
        status: ok ? ("UP" as const) : ("DEGRADED" as const),
        latencyMs,
        kvs: [
          { k: "LATENCY", v: `${latencyMs}ms` },
          { k: "HOST", v: process.env.DB_HOST || "primary" },
        ],
      };
    } catch (err) {
      return {
        name: "Postgres",
        status: "DOWN" as const,
        latencyMs: Date.now() - started,
        kvs: [
          { k: "ERROR", v: err instanceof Error ? err.message : "ping failed", tone: "danger" as const },
        ],
      };
    }
  }

  private async probeRedis() {
    const started = Date.now();
    try {
      const pong = await this.redisClient.ping();
      const latencyMs = Date.now() - started;
      const ok = pong === "PONG";
      return {
        name: "Redis",
        status: ok ? ("UP" as const) : ("DEGRADED" as const),
        latencyMs,
        kvs: [
          { k: "LATENCY", v: `${latencyMs}ms` },
          { k: "HOST", v: `${appConfig.redis.host}:${appConfig.redis.port}` },
        ],
      };
    } catch (err) {
      return {
        name: "Redis",
        status: "DOWN" as const,
        latencyMs: Date.now() - started,
        kvs: [
          { k: "ERROR", v: err instanceof Error ? err.message : "ping failed", tone: "danger" as const },
        ],
      };
    }
  }

  private async probeKafka() {
    const started = Date.now();
    const kafka = new Kafka({
      clientId: appConfig.kafka.clientId + "-healthz",
      brokers: appConfig.kafka.brokers,
      logLevel: logLevel.NOTHING,
      connectionTimeout: DEFAULT_TIMEOUT_MS,
      requestTimeout: DEFAULT_TIMEOUT_MS,
    });
    const admin = kafka.admin();
    try {
      await admin.connect();
      const cluster = await admin.describeCluster();
      const latencyMs = Date.now() - started;
      return {
        name: "Kafka",
        status: cluster.brokers.length > 0 ? ("UP" as const) : ("DEGRADED" as const),
        latencyMs,
        kvs: [
          { k: "BROKERS", v: String(cluster.brokers.length) },
          { k: "LATENCY", v: `${latencyMs}ms` },
        ],
      };
    } catch (err) {
      return {
        name: "Kafka",
        status: "DOWN" as const,
        latencyMs: Date.now() - started,
        kvs: [
          { k: "ERROR", v: err instanceof Error ? err.message : "ping failed", tone: "danger" as const },
        ],
      };
    } finally {
      try {
        await admin.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  private async checkPostgresHealth() {
    const name = "postgres";
    let status = "UP";
    let reason;

    try {
      const res = await getKnexInstance("primary").raw("SELECT 1 + 1 as result");

      if (res.rows[0].result !== 2) {
        status = "DOWN";
      }
    } catch (err: any) {
      status = "DOWN";
      reason = err.message;
    }

    return {
      name,
      status,
      reason,
    };
  }

  private async checkRedisHealth() {
    const name = "redis";
    let status = "OK";

    try {
      if ((await this.redisClient.ping()) !== "PONG") {
        status = "DEGRADED";
      }
    } catch (err: any) {
      status = "DEGRADED";
    }

    return {
      name,
      status,
    };
  }
}

export default HealthService;
