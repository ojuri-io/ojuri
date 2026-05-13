import { Kafka, Consumer, EachMessagePayload, logLevel } from "kafkajs";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import logger from "@shared/utils/logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { TransactionEvent } from "./kafka-producer";

/**
 * Message handler type
 */
export type MessageHandler = (event: TransactionEvent) => Promise<void>;

/**
 * Kafka consumer service for PAA
 * Handles consuming transaction events and processing them
 */
@singleton()
class KafkaConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private isConnected: boolean = false;
  private messageHandler: MessageHandler | null = null;
  private deadLetterHandler: ((event: TransactionEvent, error: Error) => Promise<void>) | null =
    null;
  private readonly maxRetries = 3;

  constructor() {
    this.kafka = new Kafka({
      clientId: `${appConfig.kafka.clientId}-consumer`,
      brokers: appConfig.kafka.brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 5,
      },
    });

    this.consumer = this.kafka.consumer({
      groupId: appConfig.kafka.consumerGroup,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxBytesPerPartition: 1048576, // 1MB
      retry: {
        initialRetryTime: 100,
        retries: 5,
      },
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.consumer.on("consumer.connect", () => {
      logger.info("Kafka consumer connected");
      this.isConnected = true;
    });

    this.consumer.on("consumer.disconnect", () => {
      logger.warn("Kafka consumer disconnected");
      this.isConnected = false;
    });

    this.consumer.on("consumer.group_join", ({ payload }) => {
      logger.info({ payload }, "Consumer joined group");
    });

    this.consumer.on("consumer.rebalancing", () => {
      logger.info("Consumer rebalancing...");
    });

    this.consumer.on("consumer.crash", ({ payload }) => {
      logger.error({ payload }, "Consumer crashed");
      this.isConnected = false;
    });
  }

  /**
   * Connect and subscribe to topics
   */
  async connect(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: appConfig.kafka.topic,
        fromBeginning: false,
      });
      logger.info({ topic: appConfig.kafka.topic }, "Kafka consumer subscribed to topic");
    } catch (err) {
      logger.error({ err }, "Failed to connect Kafka consumer");
      throw err;
    }
  }

  /**
   * Set message handler
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Set dead letter handler for poison messages
   */
  setDeadLetterHandler(handler: (event: TransactionEvent, error: Error) => Promise<void>): void {
    this.deadLetterHandler = handler;
  }

  /**
   * Start consuming messages
   */
  async start(): Promise<void> {
    if (!this.messageHandler) {
      throw new Error("Message handler not set");
    }

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        await this.processMessage(payload);
      },
    });

    logger.info("Kafka consumer started");
  }

  /**
   * Process a single message with retry logic
   */
  private async processMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const offset = message.offset;

    try {
      if (!message.value) {
        logger.warn({ topic, partition, offset }, "Received null message");
        await this.commitOffset(topic, partition, offset);
        return;
      }

      const event: TransactionEvent = JSON.parse(message.value.toString());

      logger.debug(
        {
          transactionId: event.transaction_id,
          partition,
          offset,
        },
        "Processing message"
      );

      // Process with retries
      await this.processWithRetry(event, 0);

      // Commit offset after successful processing
      await this.commitOffset(topic, partition, offset);

      metricsService.recordPaaMessageProcessed();

      logger.debug(
        {
          transactionId: event.transaction_id,
          partition,
          offset,
        },
        "Message processed successfully"
      );
    } catch (err: any) {
      logger.error({ err, topic, partition, offset }, "Failed to process message");
      metricsService.recordError("kafka_process_error");

      // Still commit to avoid blocking - error is logged and can be reprocessed from DLQ
      await this.commitOffset(topic, partition, offset);
    }
  }

  /**
   * Process message with retry logic
   */
  private async processWithRetry(event: TransactionEvent, attempt: number): Promise<void> {
    try {
      await this.messageHandler!(event);
    } catch (err: any) {
      if (attempt < this.maxRetries) {
        logger.warn(
          { err, transactionId: event.transaction_id, attempt },
          "Message processing failed, retrying..."
        );
        await this.sleep(100 * Math.pow(2, attempt));
        return this.processWithRetry(event, attempt + 1);
      }

      // Send to dead letter queue
      if (this.deadLetterHandler) {
        logger.error(
          { transactionId: event.transaction_id },
          "Moving message to dead letter queue"
        );
        await this.deadLetterHandler(event, err);
      }

      throw err;
    }
  }

  /**
   * Commit offset manually
   */
  private async commitOffset(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([
      {
        topic,
        partition,
        offset: (parseInt(offset) + 1).toString(),
      },
    ]);
  }

  /**
   * Disconnect consumer
   */
  async disconnect(): Promise<void> {
    await this.consumer.disconnect();
    logger.info("Kafka consumer disconnected");
  }

  /**
   * Check if consumer is ready
   */
  isReady(): boolean {
    return this.isConnected;
  }

  /**
   * Get consumer lag for monitoring
   */
  async getLag(): Promise<Map<number, number>> {
    const lag = new Map<number, number>();

    try {
      const admin = this.kafka.admin();
      await admin.connect();

      const offsets = await admin.fetchTopicOffsets(appConfig.kafka.topic);
      const groupOffsets = await admin.fetchOffsets({
        groupId: appConfig.kafka.consumerGroup,
        topics: [appConfig.kafka.topic],
      });

      for (const topicOffset of groupOffsets) {
        for (const partitionData of topicOffset.partitions) {
          const partition = partitionData.partition;
          const consumerOffset = parseInt(partitionData.offset);
          const topicPartitionOffset = offsets.find((o) => o.partition === partition);

          if (topicPartitionOffset) {
            const topicOffset = parseInt(topicPartitionOffset.offset);
            const partitionLag = topicOffset - consumerOffset;
            lag.set(partition, partitionLag);
            metricsService.updateConsumerLag(partition, partitionLag);
          }
        }
      }

      await admin.disconnect();
    } catch (err) {
      logger.error({ err }, "Failed to get consumer lag");
    }

    return lag;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default KafkaConsumer;
