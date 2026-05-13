import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { getKnexInstance } from "./database";
import { TransactionEvent, NetworkFeatures } from "./types";

const log = createServiceLogger("PostgresService");

class PostgresService {
  private transactionBuffer: TransactionEvent[] = [];
  private graphMetadataBuffer: Map<string, NetworkFeatures & { updatedAt: Date }> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly batchSize = 100;
  private readonly flushIntervalMs = 10000;

  constructor() {
    this.startPeriodicFlush();
  }

  queueTransaction(event: TransactionEvent): void {
    this.transactionBuffer.push(event);

    if (this.transactionBuffer.length >= this.batchSize) {
      this.flushTransactions();
    }
  }

  queueGraphMetadata(userId: string, features: NetworkFeatures): void {
    this.graphMetadataBuffer.set(userId, {
      ...features,
      updatedAt: new Date(),
    });

    if (this.graphMetadataBuffer.size >= this.batchSize) {
      this.flushGraphMetadata();
    }
  }

  async flushTransactions(): Promise<void> {
    if (this.transactionBuffer.length === 0) return;

    const transactions = [...this.transactionBuffer];
    this.transactionBuffer = [];

    try {
      const knex = getKnexInstance();
      const records = transactions.map((event) => ({
        transactionId: event.transaction_id,
        senderId: event.sender_id,
        receiverId: event.receiver_id,
        amount: event.amount,
        transactionType: event.transaction_type,
        timestamp: event.timestamp,
        fraudLabel: event.fraud,
        fraudProbability: event.fraud_probability,
        deviceFingerprint: JSON.stringify(event.device_fingerprint || {}),
      }));

      await knex("transactions").insert(records).onConflict("transactionId").ignore();

      metricsService.recordPostgresInsertSuccess();
      log.success("flushTransactions", "Transactions flushed to database", { count: records.length });
    } catch (err) {
      log.error("flushTransactions", "Failed to flush transactions to database", {
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordPostgresInsertError();
      this.transactionBuffer.push(...transactions);
    }
  }

  async flushGraphMetadata(): Promise<void> {
    if (this.graphMetadataBuffer.size === 0) return;

    const metadata = new Map(this.graphMetadataBuffer);
    this.graphMetadataBuffer.clear();

    try {
      const knex = getKnexInstance();
      const records = Array.from(metadata.entries()).map(([userId, features]) => ({
        userId: userId,
        pagerank: features.pagerank,
        clusteringCoefficient: features.clusteringCoef,
        communityId: features.communityId,
        degreeCentrality: features.degreeCentrality,
      }));

      for (const record of records) {
        await knex("graphMetadata").insert(record).onConflict("userId").merge();
      }

      metricsService.recordPostgresInsertSuccess();
      log.success("flushGraphMetadata", "Graph metadata flushed to database", { count: records.length });
    } catch (err) {
      log.error("flushGraphMetadata", "Failed to flush graph metadata to database", {
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordPostgresInsertError();
      for (const [userId, features] of metadata) {
        this.graphMetadataBuffer.set(userId, features);
      }
    }
  }

  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(async () => {
      await Promise.all([this.flushTransactions(), this.flushGraphMetadata()]);
    }, this.flushIntervalMs);
  }

  async loadGraphData(): Promise<{ transactions: TransactionEvent[] }> {
    try {
      const knex = getKnexInstance();
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const transactions = await knex("transactions")
        .where("timestamp", ">=", thirtyDaysAgo)
        .orderBy("timestamp", "asc");

      log.success("loadGraphData", "Graph data loaded from database", { transactionCount: transactions.length });

      return {
        transactions: transactions.map((t: any) => ({
          transaction_id: t.transactionId,
          sender_id: t.senderId,
          receiver_id: t.receiverId,
          amount: parseFloat(t.amount),
          transaction_type: t.transactionType,
          timestamp: t.timestamp,
          fraud: t.fraudLabel,
          fraud_probability: t.fraudProbability,
          decision: t.fraudLabel ? "DECLINE" : "ACCEPT",
          device_fingerprint: t.deviceFingerprint,
          processed_at: t.createdAt?.getTime() || Date.now(),
        })),
      };
    } catch (err) {
      log.error("loadGraphData", "Failed to load graph data from database", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { transactions: [] };
    }
  }

  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await Promise.all([this.flushTransactions(), this.flushGraphMetadata()]);
  }
}

export const postgresService = new PostgresService();
export default PostgresService;
