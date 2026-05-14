import "reflect-metadata";
import { container } from "tsyringe";
import App from "./app";
import appConfig from "./config/app.config";
import logger from "./shared/utils/logger";
import KafkaProducer from "./shared/kafka/kafka-producer";
import ModelRegistryService from "./shared/models/model-registry.service";
import RulesService from "./shared/rules/rules.service";
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
}

process
  .on("uncaughtException", (err) => {
    logger.error({ err });
    stopWebhookWorker();
    app.close();
    process.exit(1);
  })
  .on("SIGINT", async () => {
    const kafkaProducer = container.resolve(KafkaProducer);
    await kafkaProducer.disconnect();
    stopWebhookWorker();
    app.close();
    process.exit(0);
  });

start().catch((err) => {
  logger.error({ err });
  process.exit(1);
});
