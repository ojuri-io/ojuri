// Forces ts-node to load the FastifyRequest augmentation when running
// hot-reload — `import` of a .d.ts isn't a runtime concept.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/fastify.d.ts" />
import "reflect-metadata";
import { container } from "tsyringe";
import App from "./app";
import appConfig from "./config/app.config";
import logger from "./shared/utils/logger";
import KafkaProducer from "./shared/kafka/kafka-producer";
import ModelRegistryService from "./shared/models/model-registry.service";
import RulesService from "./shared/rules/rules.service";
import RuntimeSettingsService from "./shared/settings/runtime-settings.service";
import { startWebhookWorker, stopWebhookWorker } from "./shared/webhooks/webhook-worker";
import { loadCatalog } from "./shared/features/feature-catalog";

const app = new App();

async function start() {
  // Load + validate the feature catalogue first. A malformed catalogue
  // means an unknown model contract — better to fail boot than to
  // silently serve predictions with a broken input shape.
  const catalog = loadCatalog();
  logger.info(
    {
      schemaVersion: catalog.schemaVersion,
      inputDimension: catalog.inputDimension,
      adopterFeatures: catalog.features.length - 64,
    },
    "Feature catalogue loaded"
  );

  const kafkaProducer = container.resolve(KafkaProducer);
  try {
    await kafkaProducer.connect();
  } catch (err) {
    logger.warn({ err }, "Kafka producer failed to connect - will retry on publish");
  }

  // Warm the runtime-settings cache before the registry resolves
  // anything — the registry's threshold fallback chain depends on it.
  const runtimeSettings = container.resolve(RuntimeSettingsService);
  await runtimeSettings.start().catch((err) =>
    logger.warn({ err }, "Runtime settings initial load failed - using env fallbacks until refresh")
  );

  // Hydrate registry caches before accepting traffic so the first
  // /v1/predict request after boot doesn't synchronously hit Postgres
  // just to figure out which model and threshold to use.
  const modelRegistry = container.resolve(ModelRegistryService);
  await modelRegistry.initialize().catch((err) =>
    logger.warn({ err }, "Model registry initial load failed - will retry on schedule")
  );

  const rules = container.resolve(RulesService);
  await rules.initialize().catch((err) =>
    logger.warn({ err }, "Rules initial load failed - will retry on schedule")
  );

  startWebhookWorker();

  const address = await app.listen(appConfig.server.port);
  logger.info(`${appConfig.app.name} started on ${address}`);

  warnIfUnsafeDefaults();
}

/**
 * Surface footguns that ship with a fresh checkout: an unauthenticated
 * /v1/predict surface, a dev JWT secret, or a localhost-only CORS list
 * in production. Operators almost always want one of these flipped before
 * exposing the service to anything beyond their own laptop.
 */
function warnIfUnsafeDefaults(): void {
  const isProduction = process.env.NODE_ENV === "production";
  const requireApiKey = (process.env.RDA_REQUIRE_API_KEY ?? "false").toLowerCase() === "true";
  const jwtSecret = process.env.AUTH_JWT_SECRET ?? "";
  const corsOrigins = process.env.SENTINEL_CORS_ORIGINS ?? "";

  if (!requireApiKey) {
    logger.warn(
      "RDA_REQUIRE_API_KEY is false — POST /v1/predict is OPEN to any caller that can reach this process. " +
        "Set RDA_REQUIRE_API_KEY=true and issue keys via POST /v1/admin/api-keys before exposing this beyond your own host."
    );
  }

  if (jwtSecret.startsWith("dev-only-secret") || jwtSecret.length < 32) {
    const message =
      "AUTH_JWT_SECRET is the development default or shorter than 32 characters. " +
      "Generate a real secret (e.g. `openssl rand -base64 48`) and set AUTH_JWT_SECRET before exposing this service.";
    if (isProduction) {
      logger.error(message + " Refusing to continue with NODE_ENV=production.");
      process.exit(1);
    }
    logger.warn(message);
  }

  if (isProduction && (corsOrigins.length === 0 || corsOrigins.includes("localhost"))) {
    logger.warn(
      "SENTINEL_CORS_ORIGINS is unset or still points at localhost in production. " +
        "Set it to your dashboard's public origin(s), e.g. SENTINEL_CORS_ORIGINS=https://sentinel.example.com"
    );
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown signal received — draining");
  try {
    const kafkaProducer = container.resolve(KafkaProducer);
    await kafkaProducer.disconnect();
  } catch (err) {
    logger.warn({ err }, "Kafka producer disconnect raised during shutdown");
  }
  stopWebhookWorker();
  app.close();
  process.exit(0);
}

process
  .on("uncaughtException", (err) => {
    logger.error({ err });
    stopWebhookWorker();
    app.close();
    process.exit(1);
  })
  .on("SIGINT", () => gracefulShutdown("SIGINT"))
  .on("SIGTERM", () => gracefulShutdown("SIGTERM"));

start().catch((err) => {
  logger.error({ err });
  process.exit(1);
});
