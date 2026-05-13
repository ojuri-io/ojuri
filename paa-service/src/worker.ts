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
        // 1. Update graph with new transaction
        log.debug("processTransaction", "Updating transaction graph");
        graphService.addTransaction(event);

        // 2. Record transaction for velocity calculation
        log.debug("processTransaction", "Recording velocity metrics");
        velocityService.recordTransaction(event);

        // 3. Calculate velocity metrics for sender
        const velocityMetrics = velocityService.calculateMetrics(event.sender_id, event.timestamp);

        // 4. Get network features for sender
        const networkFeatures = graphService.getNetworkFeatures(event.sender_id);

        // 5. Combine features and queue Redis update
        const combinedFeatures: CombinedFeatures = {
          ...velocityMetrics,
          ...networkFeatures,
          updated_at: Date.now(),
        };

        log.debug("processTransaction", "Queueing Redis feature update");
        redisUpdateService.queueUpdate(event.sender_id, combinedFeatures);

        // 6. Queue transaction for PostgreSQL persistence
        log.debug("processTransaction", "Queueing PostgreSQL persistence");
        postgresService.queueTransaction(event);

        // 7. Queue graph metadata update (less frequently)
        if (processedCount % 100 === 0) {
          postgresService.queueGraphMetadata(event.sender_id, networkFeatures);
        }

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
    const { transactions } = await postgresService.loadGraphData();

    for (const transaction of transactions) {
      graphService.addTransaction(transaction);
      velocityService.recordTransaction(transaction);
    }

    graphService.computeNetworkMetrics();

    const graphStats = graphService.getStats();
    const velocityStats = velocityService.getStats();

    log.success("loadHistoricalData", "Historical data loaded", {
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

/**
 * Start lag monitoring
 */
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

/**
 * Graceful shutdown
 */
async function shutdown(metricsServer: http.Server): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.entry("shutdown", "Shutting down PAA worker");

  try {
    await kafkaConsumer.disconnect();
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

    // Connect to Kafka
    await kafkaConsumer.connect();

    // Set message handler
    kafkaConsumer.setMessageHandler(processTransaction);

    // Start consuming
    await kafkaConsumer.start();

    // Start lag monitoring
    startLagMonitoring();

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
