import Redis from "ioredis";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import logger from "@shared/utils/logger";

@singleton()
class RedisClient {
  private client: Redis;

  get() {
    this.client = this.client || this.createClient();

    return this.client;
  }

  private createClient() {
    const retryStrategy = (attempts) => {
      const delay = Math.min(attempts * 1000, 15000);
      return delay;
    };

    const reconnectOnError = (err) => {
      const targetError = "READONLY";
      if (err.message.slice(0, targetError.length) === targetError) {
        // Only reconnect when the error starts with 'READONLY'
        return true;
      }
      return false;
    };

    const redisClient = new Redis({
      host: appConfig.redis.host,
      port: appConfig.redis.port,
      password: appConfig.redis.password,
      showFriendlyErrorStack: true,
      retryStrategy,
      reconnectOnError,
      enableOfflineQueue: false,
      db: 0,
    });

    redisClient.on("error", (err) => {
      logger.error({ err }, "Redis client connection error");
    });

    redisClient.on("ready", () => {
      logger.info("Redis client is ready");
    });

    redisClient.on("reconnecting", () => {
      logger.info("Redis client is reconnected");
    });

    return redisClient;
  }
}

export default RedisClient;
