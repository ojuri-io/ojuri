import { Kafka, Producer, CompressionTypes, logLevel } from "kafkajs";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { Level } from "level";
import path from "path";

const log = createServiceLogger("KafkaProducer");

/**
 * Transaction event payload for Kafka.
 *
 * Carries the full optional request context (added 2026-05-15) so PAA
 * can persist it to `transactions` and MLA can train on the same fields
 * RDA evaluated at inference time. Pre-2026-05 events without these
 * fields still parse — every optional value just lands as undefined and
 * the PAA writer maps undefined to NULL.
 */
export interface TransactionEvent {
  // ── Core (always present) ────────────────────────────────────
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: string;
  timestamp: number;
  fraud: boolean;
  fraud_probability: number;
  decision: string;
  /**
   * What drove the decision: "ML", "PRE_RULE", or "POST_RULE". Optional
   * for backward compat with pre-rules-engine consumers — downstream
   * services should treat missing as "ML".
   */
  decision_source?: string;
  /** Human-readable rule name when decision_source is a rule. */
  rule_name?: string;
  /** Audit row id, useful for downstream consumers correlating to audit. */
  audit_id?: string;
  device_fingerprint?: {
    browser?: string;
    os?: string;
    screen_resolution?: string;
  };
  processed_at: number;

  // ── Optional request context (DTO mirror) ────────────────────
  // Identity
  customer_dob?: string;
  customer_nationality?: string;
  customer_type?: string;
  customer_id_type?: string;
  account_age_days?: number;
  is_authenticated?: boolean;

  // Channel / currency
  channel?: string;
  currency?: string;
  is_inflow?: boolean;
  is_recurring?: boolean;

  // Wallet
  wallet_balance?: number;

  // Geographic
  customer_latitude?: number;
  customer_longitude?: number;
  transaction_country?: string;
  destination_country?: string;
  ip_country?: string;
  transaction_lat?: number;
  transaction_lng?: number;

  // Device / session
  ip_is_vpn?: boolean;
  device_is_trusted?: boolean;
  device_type?: string;
  session_to_txn_seconds?: number;

  // Agent (mobile-money) — only the agent_id presence flag survives
  // persistence; lat/lng/battery were dropped on review.
  agent_id?: string;

  // Receiver — no recipient_dob (low fraud signal).
  recipient_nationality?: string;
  recipient_id_type?: string;
  customer_fi?: string;
  recipient_fi?: string;

  /**
   * Adopter overflow — arbitrary JSON the adopter wants persisted with
   * the row but doesn't want a dedicated column for. The custom-feature
   * hook reads from this at both predict-time and train-time.
   */
  request_context?: Record<string, unknown>;
}

/**
 * Kafka producer service with async fire-and-forget pattern
 * Includes retry logic with exponential backoff and disk buffering fallback
 */
@singleton()
class KafkaProducer {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected: boolean = false;
  private diskBuffer: Level<string, string>;
  private bufferFlushInterval: NodeJS.Timeout | null = null;
  private readonly maxRetries = 3;
  private readonly retryDelays = [100, 500, 2000]; // Exponential backoff

  constructor() {
    this.kafka = new Kafka({
      clientId: appConfig.kafka.clientId,
      brokers: appConfig.kafka.brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 3,
      },
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    // Initialize LevelDB for disk buffering
    this.diskBuffer = new Level(path.join(process.cwd(), ".kafka-buffer"), {
      valueEncoding: "json",
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.producer.on("producer.connect", () => {
      log.info("setupEventListeners", "Kafka producer connection established");
      this.isConnected = true;
      this.startBufferFlush();
    });

    this.producer.on("producer.disconnect", () => {
      log.warn("setupEventListeners", "Kafka producer connection lost");
      this.isConnected = false;
      this.stopBufferFlush();
    });

    this.producer.on("producer.network.request_timeout", (payload) => {
      log.error("setupEventListeners", "Network request timeout", {
        payload,
      });
    });
  }

  /**
   * Connect to Kafka broker
   */
  async connect(): Promise<void> {
    try {
      log.entry("connect", "Connecting to Kafka broker", {
        brokers: appConfig.kafka.brokers,
        clientId: appConfig.kafka.clientId,
      });
      await this.producer.connect();
      log.success("connect", "Kafka producer initialized successfully");
    } catch (err) {
      log.error("connect", "Failed to connect Kafka producer", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Disconnect from Kafka broker
   */
  async disconnect(): Promise<void> {
    log.entry("disconnect", "Disconnecting Kafka producer");
    this.stopBufferFlush();
    await this.producer.disconnect();
    await this.diskBuffer.close();
    log.success("disconnect", "Kafka producer disconnected");
  }

  /**
   * Publish transaction event asynchronously (fire-and-forget)
   * Does NOT block the response - uses setImmediate to defer.
   *
   * @param event       The transaction event payload
   * @param topic       Destination topic (default: primary `transactions.completed`)
   * @param partitionKey Optional override for the message key. Defaults to
   *                     `sender_id` so events for the same user land on the
   *                     same partition (required for PAA's per-user ordering).
   *                     For topics where ordering is not needed (e.g. the FIA
   *                     blocked-investigation topic), pass `transaction_id`
   *                     so that high-fraud senders do not create hot
   *                     partitions and downstream consumers can scale linearly.
   */
  publishAsync(
    event: TransactionEvent,
    topic: string = appConfig.kafka.topic,
    partitionKey?: string
  ): void {
    const traceId = TraceContext.getTraceId();
    const key = partitionKey ?? event.sender_id;

    log.info("publishAsync", "Queueing event for fire-and-forget Kafka publish", {
      traceId,
      transactionId: event.transaction_id,
      senderId: event.sender_id,
      topic,
      partitionKey: key,
      fraud: event.fraud,
      decision: event.decision,
      amount: event.amount,
    });

    // Use setImmediate to ensure this doesn't block the response
    setImmediate(async () => {
      try {
        await this.publishWithRetry(event, topic, key, traceId);
        log.success("publishAsync", "Event published to Kafka", {
          traceId,
          transactionId: event.transaction_id,
          topic,
        });
      } catch (err) {
        log.error("publishAsync", "Failed to publish event after retries, buffering to disk", {
          traceId,
          transactionId: event.transaction_id,
          topic,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.bufferToDisk(event, topic, key);
      }
    });
  }

  /**
   * Publish with retry logic and exponential backoff
   */
  private async publishWithRetry(
    event: TransactionEvent,
    topic: string,
    partitionKey: string,
    traceId?: string,
    attempt: number = 0
  ): Promise<void> {
    try {
      if (!this.isConnected) {
        throw new Error("Kafka producer not connected");
      }

      await this.producer.send({
        topic,
        compression: CompressionTypes.GZIP,
        messages: [
          {
            key: partitionKey,
            value: JSON.stringify(event),
            timestamp: String(Date.now()),
          },
        ],
      });

      metricsService.recordKafkaPublish(topic);
      log.debug("publishWithRetry", "Message delivered to broker", {
        traceId,
        transactionId: event.transaction_id,
        topic,
        attempt,
      });
    } catch (err) {
      if (attempt < this.maxRetries) {
        const delay = this.retryDelays[attempt];
        log.warn("publishWithRetry", `Publish failed, retrying attempt ${attempt + 1}/${this.maxRetries}`, {
          traceId,
          transactionId: event.transaction_id,
          topic,
          attempt,
          delay,
        });
        await this.sleep(delay);
        return this.publishWithRetry(event, topic, partitionKey, traceId, attempt + 1);
      }
      metricsService.recordKafkaPublishError(topic);
      throw err;
    }
  }

  /**
   * Buffer event to disk using LevelDB.
   *
   * Stores the destination topic and partition key alongside the payload so
   * flushBuffer can replay each event to its original topic with the
   * original partition assignment. Entries are written in versioned form
   * (version=2) so flushBuffer can distinguish them from legacy raw events
   * left over from before the multi-topic refactor.
   */
  private async bufferToDisk(
    event: TransactionEvent,
    topic: string,
    partitionKey: string
  ): Promise<void> {
    try {
      const key = `${Date.now()}-${event.transaction_id}`;
      await this.diskBuffer.put(
        key,
        JSON.stringify({ v: 2, topic, partitionKey, event })
      );
      log.info("bufferToDisk", "Event buffered to disk for retry on reconnection", {
        transactionId: event.transaction_id,
        topic,
        key,
      });
    } catch (err) {
      log.error("bufferToDisk", "Failed to buffer event to disk", {
        transactionId: event.transaction_id,
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Start background flush of disk buffer
   */
  private startBufferFlush(): void {
    if (this.bufferFlushInterval) return;

    this.bufferFlushInterval = setInterval(async () => {
      await this.flushBuffer();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop buffer flush
   */
  private stopBufferFlush(): void {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
  }

  /**
   * Flush buffered events to Kafka
   */
  private async flushBuffer(): Promise<void> {
    if (!this.isConnected) return;

    try {
      const entries: Array<{ key: string; value: string }> = [];

      for await (const [key, value] of this.diskBuffer.iterator({ limit: 100 })) {
        entries.push({ key, value });
      }

      if (entries.length > 0) {
        log.info("flushBuffer", `Flushing ${entries.length} buffered events`, {
          count: entries.length,
        });
      }

      for (const { key, value } of entries) {
        try {
          const parsed = JSON.parse(value);
          // Versioned wrapped format: { v: 2, topic, partitionKey, event }.
          // Legacy raw-TransactionEvent entries from before the multi-topic
          // refactor are routed to the primary topic with sender_id keying
          // (the only behavior they could have had at write time).
          const isV2 =
            parsed && typeof parsed === "object" && parsed.v === 2 && "topic" in parsed;
          const event: TransactionEvent = isV2 ? parsed.event : (parsed as TransactionEvent);
          const topic: string = isV2 ? parsed.topic : appConfig.kafka.topic;
          const partitionKey: string = isV2
            ? parsed.partitionKey ?? event.sender_id
            : event.sender_id;

          await this.publishWithRetry(event, topic, partitionKey);
          await this.diskBuffer.del(key);
          log.debug("flushBuffer", "Flushed buffered event from disk", {
            key,
            transactionId: event.transaction_id,
            topic,
          });
        } catch (err) {
          // Continue past per-entry failures. A persistent failure on one
          // topic must not block flush progress for healthy entries on other
          // topics. The failed entry stays in the buffer and will be retried
          // on the next flush tick.
          log.error("flushBuffer", "Failed to flush buffered event, leaving in buffer for retry", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error("flushBuffer", "Error during buffer flush", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check if producer is ready
   */
  isReady(): boolean {
    return this.isConnected;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default KafkaProducer;
