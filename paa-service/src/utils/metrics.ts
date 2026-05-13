import client, { Registry, Counter, Histogram, Gauge } from "prom-client";

class MetricsService {
  private registry: Registry;

  // Message processing metrics
  private messagesProcessed!: Counter<string>;
  private processingLatency!: Histogram<string>;
  private processingErrors!: Counter<string>;

  // Graph metrics
  private graphSize!: Gauge<string>;
  private pagerankComputeTime!: Histogram<string>;

  // Consumer metrics
  private consumerLag!: Gauge<string>;

  // Redis metrics
  private redisUpdateSuccess!: Counter<string>;
  private redisUpdateErrors!: Counter<string>;

  // PostgreSQL metrics
  private postgresInsertSuccess!: Counter<string>;
  private postgresInsertErrors!: Counter<string>;

  constructor() {
    this.registry = new Registry();
    client.collectDefaultMetrics({ register: this.registry });
    this.initializeMetrics();
  }

  private initializeMetrics() {
    this.messagesProcessed = new Counter({
      name: "paa_messages_processed_total",
      help: "Total messages processed by PAA",
      registers: [this.registry],
    });

    this.processingLatency = new Histogram({
      name: "paa_processing_duration_ms",
      help: "Message processing duration in milliseconds",
      buckets: [50, 100, 200, 500, 1000, 2000, 5000],
      registers: [this.registry],
    });

    this.processingErrors = new Counter({
      name: "paa_processing_errors_total",
      help: "Total processing errors",
      labelNames: ["type"],
      registers: [this.registry],
    });

    this.graphSize = new Gauge({
      name: "paa_graph_size",
      help: "Current graph size",
      labelNames: ["type"],
      registers: [this.registry],
    });

    this.pagerankComputeTime = new Histogram({
      name: "paa_pagerank_compute_duration_ms",
      help: "PageRank computation duration in milliseconds",
      buckets: [100, 500, 1000, 2000, 5000, 10000],
      registers: [this.registry],
    });

    this.consumerLag = new Gauge({
      name: "paa_consumer_lag",
      help: "Kafka consumer lag",
      labelNames: ["partition"],
      registers: [this.registry],
    });

    this.redisUpdateSuccess = new Counter({
      name: "paa_redis_updates_success_total",
      help: "Successful Redis updates",
      registers: [this.registry],
    });

    this.redisUpdateErrors = new Counter({
      name: "paa_redis_updates_errors_total",
      help: "Failed Redis updates",
      registers: [this.registry],
    });

    this.postgresInsertSuccess = new Counter({
      name: "paa_postgres_inserts_success_total",
      help: "Successful PostgreSQL inserts",
      registers: [this.registry],
    });

    this.postgresInsertErrors = new Counter({
      name: "paa_postgres_inserts_errors_total",
      help: "Failed PostgreSQL inserts",
      registers: [this.registry],
    });
  }

  recordMessageProcessed() {
    this.messagesProcessed.inc();
  }

  recordProcessingLatency(durationMs: number) {
    this.processingLatency.observe(durationMs);
  }

  recordProcessingError(type: string) {
    this.processingErrors.inc({ type });
  }

  updateGraphSize(nodes: number, edges: number) {
    this.graphSize.set({ type: "nodes" }, nodes);
    this.graphSize.set({ type: "edges" }, edges);
  }

  recordPagerankComputeTime(durationMs: number) {
    this.pagerankComputeTime.observe(durationMs);
  }

  updateConsumerLag(partition: number, lag: number) {
    this.consumerLag.set({ partition: String(partition) }, lag);
  }

  recordRedisUpdateSuccess() {
    this.redisUpdateSuccess.inc();
  }

  recordRedisUpdateError() {
    this.redisUpdateErrors.inc();
  }

  recordPostgresInsertSuccess() {
    this.postgresInsertSuccess.inc();
  }

  recordPostgresInsertError() {
    this.postgresInsertErrors.inc();
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}

export const metricsService = new MetricsService();
export default MetricsService;
