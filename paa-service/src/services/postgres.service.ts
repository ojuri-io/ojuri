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
        // Do NOT persist the system's own decision as `fraudLabel` —
        // doing so creates a feedback loop where the next training run
        // learns to reproduce past decisions instead of detecting real
        // fraud. The 2026-05-14 schema migration introduced
        // `groundTruthFraud` for verified labels (chargebacks, reviewer
        // overrides, customer reports) — `fraudLabel` is left NULL here
        // and only populated by that explicit labelling path. The
        // decision itself is already recorded in `decisionAuditLog` for
        // auditability, and `fraudProbability` below preserves the
        // model's confidence for downstream calibration work.
        fraudLabel: null,
        fraudProbability: event.fraud_probability,
        // Persist what drove the decision so MLA can exclude
        // rule-driven rows from its training set. Pre-rules-engine
        // events won't carry this field — leave NULL and let MLA
        // treat NULL as "ML" for backward compatibility.
        decisionSource: event.decision_source ?? null,
        ruleName: event.rule_name ?? null,
        // Persist NULL when no fingerprint was sent — `{}` would
        // mask the difference between "operator omitted" and "no
        // data available" and breaks the rest of the optional-context
        // column convention. Empty `{}` from a misbehaving caller is
        // also treated as absence; the next call with real data
        // overwrites it.
        deviceFingerprint:
          event.device_fingerprint && Object.keys(event.device_fingerprint).length > 0
            ? JSON.stringify(event.device_fingerprint)
            : null,

        // ── Identity ──────────────────────────────────────────
        customerDob: event.customer_dob ?? null,
        customerNationality: event.customer_nationality ?? null,
        customerType: event.customer_type ?? null,
        customerIdType: event.customer_id_type ?? null,
        accountAgeDays: event.account_age_days ?? null,
        isAuthenticated: event.is_authenticated ?? null,

        // ── Channel + currency ────────────────────────────────
        channel: event.channel ?? null,
        currency: event.currency ?? null,
        isInflow: event.is_inflow ?? null,
        isRecurring: event.is_recurring ?? null,

        // ── Wallet ────────────────────────────────────────────
        walletBalance: event.wallet_balance ?? null,

        // ── Geographic ────────────────────────────────────────
        customerLatitude: event.customer_latitude ?? null,
        customerLongitude: event.customer_longitude ?? null,
        transactionCountry: event.transaction_country ?? null,
        destinationCountry: event.destination_country ?? null,
        ipCountry: event.ip_country ?? null,
        transactionLat: event.transaction_lat ?? null,
        transactionLng: event.transaction_lng ?? null,

        // ── Device / session ──────────────────────────────────
        ipIsVpn: event.ip_is_vpn ?? null,
        deviceIsTrusted: event.device_is_trusted ?? null,
        deviceType: event.device_type ?? null,
        sessionToTxnSeconds: event.session_to_txn_seconds ?? null,

        // ── Agent (presence flag only) ────────────────────────
        agentId: event.agent_id ?? null,

        // ── Receiver ──────────────────────────────────────────
        recipientNationality: event.recipient_nationality ?? null,
        recipientIdType: event.recipient_id_type ?? null,
        customerFi: event.customer_fi ?? null,
        recipientFi: event.recipient_fi ?? null,

        // ── Adopter overflow ──────────────────────────────────
        requestContext: event.request_context ? JSON.stringify(event.request_context) : null,

        // ── Display names ─────────────────────────────────────
        customerAccountName: event.customer_account_name ?? null,
        beneficiaryAccountName: event.beneficiary_account_name ?? null,
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

      // Cap the cold-start replay so a 30-day window on a 50k-txn/day
      // deployment doesn't OOM the worker (1.5M rows). Override via env
      // when the host has enough RAM to absorb a larger window.
      const historicalLimit = Math.max(
        Number(process.env.HISTORICAL_LOAD_LIMIT) || 100_000,
        1_000
      );

      const transactions = await knex("transactions")
        .where("timestamp", ">=", thirtyDaysAgo)
        .orderBy("timestamp", "asc")
        .limit(historicalLimit);

      log.success("loadGraphData", "Graph data loaded from database", {
        transactionCount: transactions.length,
        historicalLimit,
      });

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
