import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { getKnexInstance } from "./database";
import { TransactionEvent, NodeSnapshot, EdgeSnapshot } from "./types";

const log = createServiceLogger("PostgresService");

class PostgresService {
  private transactionBuffer: TransactionEvent[] = [];
  private graphMetadataBuffer: Map<string, NodeSnapshot> = new Map();
  private edgeBuffer: Map<string, EdgeSnapshot> = new Map();
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

  queueGraphMetadata(userId: string, snapshot: NodeSnapshot): void {
    this.graphMetadataBuffer.set(userId, snapshot);

    if (this.graphMetadataBuffer.size >= this.batchSize) {
      this.flushGraphMetadata();
    }
  }

  queueEdge(edge: EdgeSnapshot): void {
    this.edgeBuffer.set(`${edge.senderId}|${edge.receiverId}`, edge);

    if (this.edgeBuffer.size >= this.batchSize) {
      this.flushEdges();
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
      const records = Array.from(metadata.entries()).map(([userId, snap]) => ({
        userId,
        pagerank: snap.pagerank,
        clusteringCoefficient: snap.clusteringCoef,
        communityId: snap.communityId,
        degreeCentrality: snap.degreeCentrality,
        inDegree: snap.inDegree,
        outDegree: snap.outDegree,
        firstSeen: new Date(snap.firstSeen),
        lastSeen: new Date(snap.lastSeen),
        transactionCount: snap.transactionCount,
        totalAmount: snap.totalAmount,
      }));

      await knex("graphMetadata").insert(records).onConflict("userId").merge();

      metricsService.recordPostgresInsertSuccess();
      log.success("flushGraphMetadata", "Graph metadata flushed to database", { count: records.length });
    } catch (err) {
      log.error("flushGraphMetadata", "Failed to flush graph metadata to database", {
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordPostgresInsertError();
      for (const [userId, snap] of metadata) {
        this.graphMetadataBuffer.set(userId, snap);
      }
    }
  }

  async flushEdges(): Promise<void> {
    if (this.edgeBuffer.size === 0) return;

    const edges = new Map(this.edgeBuffer);
    this.edgeBuffer.clear();

    try {
      const knex = getKnexInstance();
      const records = Array.from(edges.values()).map((e) => ({
        senderId: e.senderId,
        receiverId: e.receiverId,
        weight: e.weight,
        totalAmount: e.totalAmount,
        firstTransaction: e.firstTransaction,
        lastTransaction: e.lastTransaction,
        transactionTypes: JSON.stringify(e.transactionTypes),
      }));

      await knex("transactionEdges")
        .insert(records)
        .onConflict(["senderId", "receiverId"])
        .merge();

      metricsService.recordPostgresInsertSuccess();
      log.success("flushEdges", "Edges flushed to database", { count: records.length });
    } catch (err) {
      log.error("flushEdges", "Failed to flush edges to database", {
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordPostgresInsertError();
      for (const [key, e] of edges) {
        this.edgeBuffer.set(key, e);
      }
    }
  }

  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(async () => {
      await Promise.all([
        this.flushTransactions(),
        this.flushGraphMetadata(),
        this.flushEdges(),
      ]);
    }, this.flushIntervalMs);
  }

  // Returns the durable edge list along with each user's last
  // observed node state, so PAA can boot without depending on the
  // 30-day transactions replay. The caller still tails any
  // transactions newer than `latestEdgeTimestamp` to catch up.
  async loadGraphState(): Promise<{
    edges: EdgeSnapshot[];
    nodeState: Array<{ userId: string; firstSeen: number; lastSeen: number; transactionCount: number; totalAmount: number }>;
    latestEdgeTimestamp: number;
  }> {
    const knex = getKnexInstance();
    try {
      const edgeRows = await knex("transactionEdges").select("*");
      const nodeRows = await knex("graphMetadata").select(
        "userId",
        "firstSeen",
        "lastSeen",
        "transactionCount",
        "totalAmount"
      );

      const edges: EdgeSnapshot[] = edgeRows.map((r: any) => ({
        senderId: r.senderId,
        receiverId: r.receiverId,
        weight: Number(r.weight),
        totalAmount: parseFloat(r.totalAmount),
        firstTransaction: Number(r.firstTransaction),
        lastTransaction: Number(r.lastTransaction),
        transactionTypes: Array.isArray(r.transactionTypes)
          ? r.transactionTypes
          : typeof r.transactionTypes === "string"
            ? JSON.parse(r.transactionTypes)
            : [],
      }));

      const nodeState = nodeRows
        .filter((r: any) => r.firstSeen || r.lastSeen)
        .map((r: any) => ({
          userId: r.userId,
          firstSeen: r.firstSeen ? new Date(r.firstSeen).getTime() : 0,
          lastSeen: r.lastSeen ? new Date(r.lastSeen).getTime() : 0,
          transactionCount: Number(r.transactionCount) || 0,
          totalAmount: parseFloat(r.totalAmount) || 0,
        }));

      const latestEdgeTimestamp = edges.reduce(
        (max, e) => (e.lastTransaction > max ? e.lastTransaction : max),
        0
      );

      log.success("loadGraphState", "Graph state loaded from database", {
        edges: edges.length,
        nodes: nodeState.length,
        latestEdgeTimestamp,
      });

      return { edges, nodeState, latestEdgeTimestamp };
    } catch (err) {
      log.error("loadGraphState", "Failed to load graph state from database", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { edges: [], nodeState: [], latestEdgeTimestamp: 0 };
    }
  }

  /**
   * Users appearing on either side of a confirmed-fraud transaction.
   * `sinceMs` filters on groundTruthRecordedAt for incremental polls.
   */
  async loadFraudFlaggedUsers(
    sinceMs?: number
  ): Promise<{ userIds: string[]; latestRecordedAtMs: number }> {
    try {
      const knex = getKnexInstance();
      let query = knex("transactions")
        .where({ groundTruthFraud: true })
        .select("senderId", "receiverId", "groundTruthRecordedAt")
        .orderBy("groundTruthRecordedAt", "asc")
        .limit(50_000);
      if (sinceMs) {
        query = query.where("groundTruthRecordedAt", ">", new Date(sinceMs));
      }
      const rows = await query;

      const userIds = new Set<string>();
      let latestRecordedAtMs = sinceMs ?? 0;
      for (const row of rows) {
        if (row.senderId) userIds.add(row.senderId);
        if (row.receiverId) userIds.add(row.receiverId);
        const recordedAt = row.groundTruthRecordedAt
          ? new Date(row.groundTruthRecordedAt).getTime()
          : 0;
        if (recordedAt > latestRecordedAtMs) latestRecordedAtMs = recordedAt;
      }

      return { userIds: [...userIds], latestRecordedAtMs };
    } catch (err) {
      log.error("loadFraudFlaggedUsers", "Failed to load fraud-flagged users", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { userIds: [], latestRecordedAtMs: sinceMs ?? 0 };
    }
  }

  async loadGraphData(sinceTimestamp?: number): Promise<{ transactions: TransactionEvent[] }> {
    try {
      const knex = getKnexInstance();
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const cutoff = sinceTimestamp ?? thirtyDaysAgo;

      // Cap the replay so a wide window on a busy deployment doesn't
      // OOM the worker. Override via env when the host has the RAM.
      const historicalLimit = Math.max(
        Number(process.env.HISTORICAL_LOAD_LIMIT) || 100_000,
        1_000
      );

      const transactions = await knex("transactions")
        .where("timestamp", ">=", cutoff)
        .orderBy("timestamp", "asc")
        .limit(historicalLimit);

      log.success("loadGraphData", "Graph data loaded from database", {
        transactionCount: transactions.length,
        historicalLimit,
        sinceTimestamp: cutoff,
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

  // See RedisUpdateService.stop — a fenced-out instance discards its
  // buffer instead of writing a partial-graph snapshot.
  async stop({ discard = false } = {}): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    if (!discard) {
      await Promise.all([this.flushTransactions(), this.flushGraphMetadata(), this.flushEdges()]);
      return;
    }

    const dropped =
      this.transactionBuffer.length + this.graphMetadataBuffer.size + this.edgeBuffer.size;
    this.transactionBuffer.length = 0;
    this.graphMetadataBuffer.clear();
    this.edgeBuffer.clear();
    log.warn("stop", "Discarded buffered Postgres writes after losing the leader lease", { dropped });
  }
}

export const postgresService = new PostgresService();
export default PostgresService;
