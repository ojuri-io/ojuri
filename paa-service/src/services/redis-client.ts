import Redis from "ioredis";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@utils/service-logger";

const log = createServiceLogger("RedisClient");

class RedisClient {
  private client: Redis | null = null;

  get(): Redis {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private createClient(): Redis {
    const retryStrategy = (attempts: number) => {
      const delay = Math.min(attempts * 1000, 15000);
      return delay;
    };

    const reconnectOnError = (err: Error) => {
      const targetError = "READONLY";
      if (err.message.slice(0, targetError.length) === targetError) {
        return true;
      }
      return false;
    };

    const redisClient = new Redis({
      host: appConfig.redis.host,
      port: appConfig.redis.port,
      password: appConfig.redis.password || undefined,
      showFriendlyErrorStack: true,
      retryStrategy,
      reconnectOnError,
      enableOfflineQueue: false,
      db: 0,
    });

    redisClient.on("error", (err) => {
      log.error("createClient", "Redis client connection error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    redisClient.on("ready", () => {
      log.info("createClient", "Redis client is ready");
    });

    redisClient.on("reconnecting", () => {
      log.info("createClient", "Redis client is reconnecting");
    });

    return redisClient;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}

export const redisClient = new RedisClient();
export default RedisClient;
