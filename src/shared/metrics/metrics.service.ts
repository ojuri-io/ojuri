import { singleton } from "tsyringe";
import client, { Registry, Counter, Histogram, Gauge } from "prom-client";
import { CircuitState } from "@shared/circuit-breaker/circuit-breaker";

/**
 * Prometheus metrics service for observability
 * Exposes metrics for latency, throughput, errors, cache hits, and circuit breaker states
 */
@singleton()
class MetricsService {
  private registry: Registry;

  // Request metrics
  private requestCounter: Counter<string>;
  private requestLatencyHistogram: Histogram<string>;
  private errorCounter: Counter<string>;

  // Decision metrics
  private decisionCounter: Counter<string>;

  // Cache metrics
  private cacheHitCounter: Counter<string>;
  private cacheMissCounter: Counter<string>;

  // Circuit breaker metrics
  private circuitBreakerState: Gauge<string>;
  private circuitBreakerEvents: Counter<string>;

  // Model metrics
  private modelInferenceLatency: Histogram<string>;
  private modelLoadTime: Gauge<string>;

  // Kafka metrics
  private kafkaPublishCounter: Counter<string>;
  private kafkaPublishErrors: Counter<string>;

  // PAA specific metrics
  private messagesProcessed: Counter<string>;
  private graphSize: Gauge<string>;
  private pagerankComputeTime: Histogram<string>;
  private consumerLag: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Add default metrics (GC, event loop, etc.)
    client.collectDefaultMetrics({ register: this.registry });

    this.initializeMetrics();
  }

  private initializeMetrics() {
    // Request metrics
    this.requestCounter = new Counter({
      name: "fraud_detection_requests_total",
      help: "Total number of fraud detection requests",
      labelNames: ["method", "path", "status"],
      registers: [this.registry],
    });

    this.requestLatencyHistogram = new Histogram({
      name: "fraud_detection_request_duration_ms",
      help: "Request duration in milliseconds",
      labelNames: ["method", "path"],
      buckets: [10, 25, 50, 75, 100, 125, 150, 200, 500, 1000],
      registers: [this.registry],
    });

    this.errorCounter = new Counter({
      name: "fraud_detection_errors_total",
      help: "Total number of errors",
      labelNames: ["type"],
      registers: [this.registry],
    });

    // Decision metrics
    this.decisionCounter = new Counter({
      name: "fraud_detection_decisions_total",
      help: "Total fraud detection decisions",
      labelNames: ["decision"],
      registers: [this.registry],
    });

    // Cache metrics
    this.cacheHitCounter = new Counter({
      name: "redis_cache_hits_total",
      help: "Total Redis cache hits",
      registers: [this.registry],
    });

    this.cacheMissCounter = new Counter({
      name: "redis_cache_misses_total",
      help: "Total Redis cache misses",
      registers: [this.registry],
    });

    // Circuit breaker metrics
    this.circuitBreakerState = new Gauge({
      name: "circuit_breaker_state",
      help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
      labelNames: ["name"],
      registers: [this.registry],
    });

    this.circuitBreakerEvents = new Counter({
      name: "circuit_breaker_events_total",
      help: "Circuit breaker events",
      labelNames: ["name", "event"],
      registers: [this.registry],
    });

    // Model metrics
    this.modelInferenceLatency = new Histogram({
      name: "onnx_model_inference_duration_ms",
      help: "ONNX model inference duration in milliseconds",
      buckets: [5, 10, 20, 30, 40, 50, 75, 100],
      registers: [this.registry],
    });

    this.modelLoadTime = new Gauge({
      name: "onnx_model_load_time_ms",
      help: "Time to load ONNX model in milliseconds",
      registers: [this.registry],
    });

    // Kafka metrics
    this.kafkaPublishCounter = new Counter({
      name: "kafka_messages_published_total",
      help: "Total Kafka messages published",
      labelNames: ["topic"],
      registers: [this.registry],
    });

    this.kafkaPublishErrors = new Counter({
      name: "kafka_publish_errors_total",
      help: "Total Kafka publish errors",
      labelNames: ["topic"],
      registers: [this.registry],
    });

    // PAA metrics
    this.messagesProcessed = new Counter({
      name: "paa_messages_processed_total",
      help: "Total messages processed by PAA",
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
  }

  /**
   * Record a request
   */
  recordRequest(method: string, path: string, status: number) {
    this.requestCounter.inc({ method, path, status: String(status) });
  }

  /**
   * Record request latency
   */
  recordLatency(method: string, path: string, durationMs: number) {
    this.requestLatencyHistogram.observe({ method, path }, durationMs);
  }

  /**
   * Record an error
   */
  recordError(type: string) {
    this.errorCounter.inc({ type });
  }

  /**
   * Record a fraud decision
   */
  recordDecision(decision: "ACCEPT" | "DECLINE") {
    this.decisionCounter.inc({ decision });
  }

  /**
   * Record cache hit
   */
  recordCacheHit() {
    this.cacheHitCounter.inc();
  }

  /**
   * Record cache miss
   */
  recordCacheMiss() {
    this.cacheMissCounter.inc();
  }

  /**
   * Record circuit breaker state
   */
  recordCircuitBreakerState(name: string, state: CircuitState) {
    const stateValue = state === CircuitState.CLOSED ? 0 : state === CircuitState.HALF_OPEN ? 1 : 2;
    this.circuitBreakerState.set({ name }, stateValue);
  }

  /**
   * Increment circuit breaker event counter
   */
  incrementCircuitBreakerEvent(name: string, event: string) {
    this.circuitBreakerEvents.inc({ name, event });
  }

  /**
   * Record model inference latency
   */
  recordModelInferenceLatency(durationMs: number) {
    this.modelInferenceLatency.observe(durationMs);
  }

  /**
   * Record model load time
   */
  recordModelLoadTime(durationMs: number) {
    this.modelLoadTime.set(durationMs);
  }

  /**
   * Record Kafka message published
   */
  recordKafkaPublish(topic: string) {
    this.kafkaPublishCounter.inc({ topic });
  }

  /**
   * Record Kafka publish error
   */
  recordKafkaPublishError(topic: string) {
    this.kafkaPublishErrors.inc({ topic });
  }

  /**
   * Record PAA message processed
   */
  recordPaaMessageProcessed() {
    this.messagesProcessed.inc();
  }

  /**
   * Update graph size
   */
  updateGraphSize(nodes: number, edges: number) {
    this.graphSize.set({ type: "nodes" }, nodes);
    this.graphSize.set({ type: "edges" }, edges);
  }

  /**
   * Record PageRank compute time
   */
  recordPagerankComputeTime(durationMs: number) {
    this.pagerankComputeTime.observe(durationMs);
  }

  /**
   * Update consumer lag
   */
  updateConsumerLag(partition: number, lag: number) {
    this.consumerLag.set({ partition: String(partition) }, lag);
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get content type for metrics
   */
  getContentType(): string {
    return this.registry.contentType;
  }
}

export const metricsService = new MetricsService();
export default MetricsService;
