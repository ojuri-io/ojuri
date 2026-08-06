import { Kafka, Consumer, EachMessagePayload, logLevel } from "kafkajs";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { processedEvents } from "./processed-events.service";
import { TransactionEvent } from "./types";

const log = createServiceLogger("KafkaConsumer");

export type MessageHandler = (event: TransactionEvent) => Promise<void>;

class KafkaConsumerService {
  private kafka: Kafka;
  private consumer: Consumer;
  private isConnected: boolean = false;
  private messageHandler: MessageHandler | null = null;
  private readonly maxRetries = 3;

  constructor() {
    this.kafka = new Kafka({
      clientId: appConfig.kafka.clientId,
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
      maxBytesPerPartition: 1048576,
      retry: {
        initialRetryTime: 100,
        retries: 5,
      },
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.consumer.on("consumer.connect", () => {
      log.info("setupEventListeners", "Kafka consumer connected");
      this.isConnected = true;
    });

    this.consumer.on("consumer.disconnect", () => {
      log.warn("setupEventListeners", "Kafka consumer disconnected");
      this.isConnected = false;
    });

    this.consumer.on("consumer.group_join", ({ payload }) => {
      log.info("setupEventListeners", "Consumer joined group", { payload });
    });

    this.consumer.on("consumer.crash", ({ payload }) => {
      log.error("setupEventListeners", "Consumer crashed", { payload });
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      log.entry("connect", "Connecting to Kafka broker", {
        brokers: appConfig.kafka.brokers,
      });
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: appConfig.kafka.topic,
        fromBeginning: false,
      });
      log.success("connect", "Kafka consumer subscribed", { topic: appConfig.kafka.topic });
    } catch (err) {
      log.error("connect", "Failed to connect Kafka consumer", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

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

    log.success("start", "Kafka consumer started");
  }

  private async processMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const offset = message.offset;

    try {
      if (!message.value) {
        log.warn("processMessage", "Received null message", { topic, partition, offset });
        await this.commitOffset(topic, partition, offset);
        return;
      }

      const event: TransactionEvent = JSON.parse(message.value.toString());

      // Outside processWithRetry: graph and velocity state are in-memory
      // and not idempotent, so a redelivery must not be applied twice —
      // but a retry of *this* delivery must still be allowed through, or
      // a transient failure would be silently swallowed as a duplicate.
      if (processedEvents.markIfNew(event.transaction_id)) {
        await this.processWithRetry(event, 0);
      } else {
        log.debug("processMessage", "Duplicate event — skipping in-memory update", {
          transactionId: event.transaction_id,
        });
      }
      await this.commitOffset(topic, partition, offset);

      metricsService.recordMessageProcessed();
    } catch (err) {
      log.error("processMessage", "Failed to process message", {
        topic,
        partition,
        offset,
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordProcessingError("kafka_process_error");
      await this.commitOffset(topic, partition, offset);
    }
  }

  private async processWithRetry(event: TransactionEvent, attempt: number): Promise<void> {
    try {
      await this.messageHandler!(event);
    } catch (err) {
      if (attempt < this.maxRetries) {
        log.warn("processWithRetry", `Retrying attempt ${attempt + 1}/${this.maxRetries}`, {
          transactionId: event.transaction_id,
          senderId: event.sender_id,
          attempt,
        });
        await this.sleep(100 * Math.pow(2, attempt));
        return this.processWithRetry(event, attempt + 1);
      }
      throw err;
    }
  }

  private async commitOffset(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([
      { topic, partition, offset: (parseInt(offset) + 1).toString() },
    ]);
  }

  async disconnect(): Promise<void> {
    await this.consumer.disconnect();
    log.info("disconnect", "Kafka consumer disconnected");
  }

  isReady(): boolean {
    return this.isConnected;
  }

  async describeGroupMembers(): Promise<{ count: number; clientIds: string[] }> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const description = await admin.describeGroups([appConfig.kafka.consumerGroup]);
      const group = description.groups.find((g) => g.groupId === appConfig.kafka.consumerGroup);
      const members = group?.members ?? [];
      return {
        count: members.length,
        clientIds: members.map((m) => m.clientId),
      };
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

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
            const topicOffsetVal = parseInt(topicPartitionOffset.offset);
            const partitionLag = topicOffsetVal - consumerOffset;
            lag.set(partition, partitionLag);
            metricsService.updateConsumerLag(partition, partitionLag);
          }
        }
      }

      await admin.disconnect();
    } catch (err) {
      log.error("getLag", "Failed to get consumer lag", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return lag;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const kafkaConsumer = new KafkaConsumerService();
export default KafkaConsumerService;
