import "reflect-metadata";
import "dotenv/config";
import "module-alias/register";

import http from "http";
import { randomUUID } from "crypto";
import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { kafkaConsumer } from "@services/kafka-consumer";
import { graphService } from "@services/graph.service";
import { velocityService } from "@services/velocity.service";
import { redisUpdateService } from "@services/redis-update.service";
import { postgresService } from "@services/postgres.service";
import { redisClient } from "@services/redis-client";
import { processedEvents } from "@services/processed-events.service";
import { leaderLease } from "@services/leader-lease.service";
import { closeDatabase } from "@services/database";
import { TransactionEvent, CombinedFeatures } from "@services/types";
import appConfig from "@config/app.config";

const log = createServiceLogger("PAAWorker");

let isShuttingDown = false;
let processedCount = 0;

/**
 * Process a single transaction event
 */
async function processTransaction(event: TransactionEvent): Promise<void> {
  const startTime = Date.now();
  const traceId = `paa-${randomUUID()}`;

  return TraceContext.runAsync(
    { traceId, transactionId: event.transaction_id, senderId: event.sender_id },
    async () => {
      log.entry("processTransaction", "Processing Kafka event", {
        amount: event.amount,
        transactionType: event.transaction_type,
      });

      try {
        // Graph and velocity state are in-memory and not idempotent, so
        // an at-least-once redelivery must not be applied twice.
        if (!processedEvents.markIfNew(event.transaction_id)) {
          log.debug("processTransaction", "Duplicate event — skipping in-memory update", {
            transactionId: event.transaction_id,
          });
          return;
        }

        // 1. Update graph with new transaction
        log.debug("processTransaction", "Updating transaction graph");
        graphService.addTransaction(event);

        // 2. Record transaction for velocity calculation
        log.debug("processTransaction", "Recording velocity metrics");
        velocityService.recordTransaction(event);

        // 3. Calculate velocity metrics for sender
        const velocityMetrics = velocityService.calculateMetrics(event.sender_id, event.timestamp);
        const pairMetrics = velocityService.calculatePairMetrics(
          event.sender_id,
          event.receiver_id,
          event.timestamp
        );

        const senderSnapshot = graphService.getNodeSnapshot(event.sender_id);
        const receiverSnapshot = graphService.getNodeSnapshot(event.receiver_id);
        const edgeSnapshot = graphService.getEdgeSnapshot(event.sender_id, event.receiver_id);

        const combinedFeatures: CombinedFeatures = {
          ...velocityMetrics,
          ...(senderSnapshot ?? {
            pagerank: 0,
            clusteringCoef: 0,
            communityId: 0,
            degreeCentrality: 0,
            inDegree: 0,
            outDegree: 0,
            isHub: 0,
            shortestPathToFraud: 99,
            neighborhoodFraudRate: 0,
          }),
          recipientLifetimeTxCount: graphService.getInboundTransactionCount(event.sender_id),
          updated_at: Date.now(),
        };

        log.debug("processTransaction", "Queueing Redis feature update");
        redisUpdateService.queueUpdate(event.sender_id, combinedFeatures);
        redisUpdateService.queuePairUpdate(event.sender_id, event.receiver_id, {
          // Edge weight is lifetime and survives restarts; the velocity
          // buffer only sees the replay window.
          priorSendCount: edgeSnapshot?.weight ?? pairMetrics.forwardCount30d,
          secondsSincePrevSend: pairMetrics.secondsSincePrevSend ?? 999999,
          roundTripCount30d: pairMetrics.roundTripCount30d,
          amountMean30d: pairMetrics.amountMean30d,
        });
        redisUpdateService.queueReceiverCount(
          event.receiver_id,
          graphService.getInboundTransactionCount(event.receiver_id)
        );

        log.debug("processTransaction", "Queueing PostgreSQL persistence");
        postgresService.queueTransaction(event);

        // Snapshot both ends of the edge + the edge itself on every
        // event. Buffers are Map-keyed so hot users/edges dedupe
        // naturally — Postgres pressure stays bounded by the batch
        // size / flush interval, not by the event rate.
        if (senderSnapshot) postgresService.queueGraphMetadata(event.sender_id, senderSnapshot);
        if (receiverSnapshot) postgresService.queueGraphMetadata(event.receiver_id, receiverSnapshot);
        if (edgeSnapshot) postgresService.queueEdge(edgeSnapshot);

        processedCount++;

        const processingTime = Date.now() - startTime;
        metricsService.recordProcessingLatency(processingTime);

        log.success("processTransaction", "Transaction processed", {
          processingTimeMs: processingTime,
          processedCount,
        });
      } catch (err) {
        log.error("processTransaction", "Error processing transaction", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  );
}

/**
 * Load historical data from PostgreSQL
 */
async function loadHistoricalData(): Promise<void> {
  log.entry("loadHistoricalData", "Loading historical data from PostgreSQL");

  try {
    // Prefer the durable edge list — it carries history older than
    // the transactions replay window. Fall back to (or tail with) a
    // transactions replay when the edge table is empty or stale.
    const state = await postgresService.loadGraphState();
    let tailSince: number | undefined;

    if (state.edges.length > 0) {
      graphService.hydrateEdges(state.edges);
      graphService.hydrateNodeState(state.nodeState);
      // Tail any events newer than the latest persisted edge so we
      // catch up on writes that landed between the last PAA shutdown
      // and now.
      tailSince = state.latestEdgeTimestamp + 1;
    }

    const { transactions } = await postgresService.loadGraphData(tailSince);

    for (const transaction of transactions) {
      graphService.addTransaction(transaction);
      velocityService.recordTransaction(transaction);
    }

    graphService.computeNetworkMetrics();

    const graphStats = graphService.getStats();
    const velocityStats = velocityService.getStats();

    log.success("loadHistoricalData", "Historical data loaded", {
      hydratedEdges: state.edges.length,
      hydratedNodes: state.nodeState.length,
      tailedTransactions: transactions.length,
      graphNodes: graphStats.nodes,
      graphEdges: graphStats.edges,
      velocityUsers: velocityStats.totalUsers,
    });
  } catch (err) {
    log.error("loadHistoricalData", "Failed to load historical data", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let fraudLabelWatermarkMs = 0;

async function syncFraudLabels(): Promise<void> {
  const { userIds, latestRecordedAtMs } = await postgresService.loadFraudFlaggedUsers(
    fraudLabelWatermarkMs || undefined
  );
  // Postgres keeps microseconds; the ms-truncated watermark re-matches
  // the newest row on every poll. The Set dedupes, so only log when
  // genuinely new users were flagged.
  const added = graphService.markFraudUsers(userIds);
  if (added > 0) {
    log.info("syncFraudLabels", "Fraud-flagged users loaded into graph", {
      newUsers: added,
      totalFraudUsers: graphService.getFraudUserCount(),
    });
  }
  if (latestRecordedAtMs > fraudLabelWatermarkMs) {
    fraudLabelWatermarkMs = latestRecordedAtMs;
  }
}

function startFraudLabelSync(): void {
  setInterval(() => {
    if (isShuttingDown) return;
    syncFraudLabels().catch((err) => {
      log.error("startFraudLabelSync", "Fraud label sync failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, appConfig.paa.fraudLabelPollIntervalMs);
}

/**
 * Start metrics HTTP server
 */
function startMetricsServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      const metrics = await metricsService.getMetrics();
      res.writeHead(200, { "Content-Type": metricsService.getContentType() });
      res.end(metrics);
    } else if (req.url === "/health" || req.url === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "UP" }));
    } else if (req.url === "/ready" || req.url === "/readyz") {
      const ready = kafkaConsumer.isReady();
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "UP" : "DOWN" }));
    } else if (req.url === "/stats") {
      const stats = {
        processedCount,
        graph: graphService.getStats(),
        velocity: velocityService.getStats(),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(appConfig.metrics.port, () => {
    log.info("startMetricsServer", "Metrics server started", { port: appConfig.metrics.port });
  });

  return server;
}

function startLagMonitoring(): void {
  setInterval(async () => {
    if (isShuttingDown) return;

    try {
      const lag = await kafkaConsumer.getLag();
      let totalLag = 0;

      for (const [, partitionLag] of lag) {
        totalLag += partitionLag;
      }

      if (totalLag > 10000) {
        log.warn("lagMonitor", "High consumer lag detected", { totalLag });
      }
    } catch (err) {
      log.error("lagMonitor", "Failed to get consumer lag", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 30000);
}

// Backstop observability for the leader lease: the lease fences new
// instances, but a group member that predates it (or a deployment with
// PAA_REQUIRE_LEADER_LEASE=false) still needs to be visible.
function startSingletonGuard(): void {
  const tick = async () => {
    if (isShuttingDown) return;
    try {
      const { count, clientIds } = await kafkaConsumer.describeGroupMembers();
      metricsService.updateConsumerGroupMembers(count);
      if (count > 1) {
        log.error("singletonGuard", "Multiple consumers in pattern-analysis group — graph state will desync", {
          count,
          clientIds,
        });
      }
    } catch (err) {
      log.warn("singletonGuard", "Failed to describe consumer group", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  setTimeout(tick, 15000);
  setInterval(tick, 60000);
}

/**
 * Graceful shutdown
 */
async function shutdown(metricsServer: http.Server): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.entry("shutdown", "Shutting down PAA worker");

  try {
    await kafkaConsumer.disconnect();
    // Before dropping the Redis connection, so the successor can take
    // over immediately instead of waiting out the TTL.
    await leaderLease.release();
    redisUpdateService.stop();
    await postgresService.stop();
    await redisClient.disconnect();
    await closeDatabase();

    metricsServer.close();

    log.success("shutdown", "PAA worker shutdown complete");
    process.exit(0);
  } catch (err) {
    log.error("shutdown", "Error during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  log.entry("main", "Starting PAA worker");

  try {
    // Start metrics server
    const metricsServer = startMetricsServer();

    // Load historical data
    await loadHistoricalData();

    // Known-fraud users must be in place before events start flowing,
    // otherwise early snapshots write default proximity values.
    await syncFraudLabels();
    startFraudLabelSync();

    // The Redis client rejects commands until connected
    // (enableOfflineQueue=false), and per-command pipeline errors are
    // dropped, not requeued — consuming before ready silently loses
    // the first feature flush.
    try {
      await redisClient.waitUntilReady(15000);
    } catch (err) {
      log.error("main", "Redis not ready — early feature writes will fail until it connects", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fence before consuming. A second replica would split the partition
    // assignment and compute graph metrics over half the graph, writing
    // degraded features to Redis for RDA's decision path.
    if (appConfig.paa.requireLeaderLease) {
      const acquired = await leaderLease.acquire();
      if (!acquired) {
        log.error("main", "Exiting: another PAA instance is the leader. PAA is a singleton.");
        process.exit(1);
      }
      leaderLease.startRenewal(() => {
        log.error("main", "Leader lease lost — shutting down to avoid a split graph");
        shutdown(metricsServer);
      });
    } else {
      log.warn("main", "PAA_REQUIRE_LEADER_LEASE=false — singleton fencing is disabled");
    }

    // Connect to Kafka
    await kafkaConsumer.connect();

    // Set message handler
    kafkaConsumer.setMessageHandler(processTransaction);

    // Start consuming
    await kafkaConsumer.start();

    // Start lag monitoring
    startLagMonitoring();
    startSingletonGuard();

    log.success("main", "PAA worker started successfully");

    // Handle shutdown signals
    process.on("SIGINT", () => shutdown(metricsServer));
    process.on("SIGTERM", () => shutdown(metricsServer));

    process.on("uncaughtException", (err) => {
      log.error("main", "Uncaught exception", {
        error: err instanceof Error ? err.message : String(err),
      });
      shutdown(metricsServer);
    });

    process.on("unhandledRejection", (reason) => {
      log.error("main", "Unhandled rejection", {
        reason: String(reason),
      });
    });
  } catch (err) {
    log.error("main", "Failed to start PAA worker", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();
