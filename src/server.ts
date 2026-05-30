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
// Must use the @shared alias (not relative): module-alias maps it to
// dist/, which is the same path predict.service.ts resolves through —
// a relative import here would load the source copy and split the
// tsyringe singleton across two distinct class objects.
import OnnxService from "@shared/onnx/onnx.service";
import RulesService from "./shared/rules/rules.service";
import RuntimeSettingsService from "./shared/settings/runtime-settings.service";
import { startWebhookWorker, stopWebhookWorker } from "./shared/webhooks/webhook-worker";
import { loadCatalog } from "./shared/features/feature-catalog";

const app = new App();

async function start() {
  // Fail boot on a malformed catalogue — silently serving predictions
  // against a broken input shape is worse than not starting.
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

  // Warm runtime-settings before the model registry — the registry's
  // threshold fallback chain depends on it.
  const runtimeSettings = container.resolve(RuntimeSettingsService);
  await runtimeSettings.start().catch((err) =>
    logger.warn({ err }, "Runtime settings initial load failed - using env fallbacks until refresh")
  );

  const modelRegistry = container.resolve(ModelRegistryService);
  await modelRegistry.initialize().catch((err) =>
    logger.warn({ err }, "Model registry initial load failed - will retry on schedule")
  );

  // Without this call the OnnxService singleton stays uninitialised
  // and every predict() falls through to mockInference silently.
  const onnxService = container.resolve(OnnxService);
  await onnxService.initialize().catch((err) =>
    logger.error({ err }, "ONNX service initialisation failed - predictions will run in degraded mock mode")
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
