import "reflect-metadata";
import { container } from "tsyringe";
import App from "./app";
import appConfig from "./config/app.config";
import logger from "./shared/utils/logger";
import KafkaProducer from "./shared/kafka/kafka-producer";

const app = new App();

async function start() {
  // Initialize Kafka producer
  const kafkaProducer = container.resolve(KafkaProducer);
  try {
    await kafkaProducer.connect();
  } catch (err) {
    logger.warn({ err }, "Kafka producer failed to connect - will retry on publish");
  }

  // Start server
  const address = await app.listen(appConfig.server.port);
  logger.info(`${appConfig.app.name} started on ${address}`);
}

process
  .on("uncaughtException", (err) => {
    logger.error({ err });
    app.close();
    process.exit(1);
  })
  .on("SIGINT", async () => {
    const kafkaProducer = container.resolve(KafkaProducer);
    await kafkaProducer.disconnect();
    app.close();
    process.exit(0);
  });

start().catch((err) => {
  logger.error({ err });
  process.exit(1);
});
