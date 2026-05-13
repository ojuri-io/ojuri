import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import Redis from "ioredis";
import httpStatus from "http-status";
import RedisClient from "@shared/redis-client/redis-client";
import { getKnexInstance } from "../../../database";

@injectable()
class HealthService {
  private redisClient: Redis;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient.get();
  }

  async readinessCheck(req: FastifyRequest, reply: FastifyReply) {
    const postgresHealth = await this.checkPostgresHealth();
    const redisHealth = await this.checkRedisHealth();

    if (postgresHealth.status === "UP" && redisHealth.status === "OK") {
      reply.code(httpStatus.OK).send({
        status: "UP",
        checks: [postgresHealth, redisHealth],
      });
    } else {
      reply.code(httpStatus.SERVICE_UNAVAILABLE).send({
        status: "DOWN",
        checks: [postgresHealth, redisHealth],
      });
    }
  }

  livelinessCheck(req: FastifyRequest, reply: FastifyReply) {
    reply.code(httpStatus.OK).send({
      status: "UP",
    });
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
