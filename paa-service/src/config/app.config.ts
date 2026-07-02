const appConfig = {
  app: {
    name: process.env.APP_NAME || "paa-service",
    env: process.env.NODE_ENV || "development",
  },
  redis: {
    host: String(process.env.REDIS_HOST || "localhost"),
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || "",
  },
  database: {
    DB_CLIENT: process.env.DB_CLIENT || "pg",
    DB_URL: String(process.env.DB_URL || "postgresql://postgres:postgres@localhost:5432/fraud_db"),
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    topic: process.env.KAFKA_TOPIC || "transactions.completed",
    consumerGroup: process.env.KAFKA_CONSUMER_GROUP || "pattern-analysis",
    clientId: process.env.KAFKA_CLIENT_ID || "paa-service",
  },
  paa: {
    graphUpdateInterval: Number(process.env.GRAPH_UPDATE_INTERVAL) || 300000,
    pagerankDamping: Number(process.env.PAGERANK_DAMPING) || 0.85,
    batchSize: Number(process.env.BATCH_SIZE) || 100,
    maxGraphNodes: Number(process.env.MAX_GRAPH_NODES) || 1000000,
    triangleRecomputeMinIntervalMs: Number(process.env.TRIANGLE_RECOMPUTE_MIN_INTERVAL_MS) || 10000,
    fraudLabelPollIntervalMs: Number(process.env.FRAUD_LABEL_POLL_INTERVAL_MS) || 300000,
  },
  metrics: {
    port: Number(process.env.METRICS_PORT) || 9090,
  },
};

export default appConfig;
