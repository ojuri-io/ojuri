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
  private consumerGroupMembers!: Gauge<string>;
  private forcedGraphEvictions!: Counter<string>;
  private duplicateEventsSkipped!: Counter<string>;
  private velocityTruncations!: Counter<string>;

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

    this.consumerGroupMembers = new Gauge({
      name: "paa_group_members",
      help: "Number of consumers in the pattern-analysis group. Must always be 1 — PAA holds graph state in-memory; >1 splits partition assignment and breaks PageRank/Louvain.",
      registers: [this.registry],
    });

    this.forcedGraphEvictions = new Counter({
      name: "paa_graph_forced_evictions_total",
      help: "Graph nodes evicted by the size cap despite being recent. Sustained non-zero means MAX_GRAPH_NODES is below the working set and features are being computed on a truncated graph.",
      registers: [this.registry],
    });

    this.duplicateEventsSkipped = new Counter({
      name: "paa_duplicate_events_skipped_total",
      help: "Replayed transaction events skipped by the dedupe window. In-memory graph/velocity state is not idempotent, so double-counting these would inflate every derived feature.",
      registers: [this.registry],
    });

    this.velocityTruncations = new Counter({
      name: "paa_velocity_truncations_total",
      help: "Velocity records dropped by the per-user memory backstop rather than by the 30-day window. Non-zero means the highest-velocity senders' windows are incomplete.",
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

  recordForcedGraphEviction(count = 1) {
    this.forcedGraphEvictions.inc(count);
  }

  recordDuplicateEventSkipped(count = 1) {
    this.duplicateEventsSkipped.inc(count);
  }

  recordVelocityTruncation(count = 1) {
    this.velocityTruncations.inc(count);
  }

  updateConsumerLag(partition: number, lag: number) {
    this.consumerLag.set({ partition: String(partition) }, lag);
  }

  updateConsumerGroupMembers(count: number) {
    this.consumerGroupMembers.set(count);
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
