import os from "os";
import { getEnv } from "./env.config";

function resolveOnnxPoolSize(): number {
  const raw = Number(process.env.ONNX_SESSION_POOL_SIZE);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 16);
  const cores = os.cpus().length || 1;
  return Math.max(1, Math.min(8, Math.ceil(cores / 2)));
}

function resolveOnnxIntraOpThreads(poolSize: number): number {
  const raw = Number(process.env.ONNX_INTRA_OP_THREADS);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 16);
  const cores = os.cpus().length || 1;
  return Math.max(1, Math.floor(cores / poolSize));
}

const ONNX_POOL_SIZE = resolveOnnxPoolSize();

const appConfig = {
  app: {
    name: process.env.APP_NAME,
    brand: process.env.BRAND_NAME,
    env: getEnv(),
  },
  server: {
    port: Number(process.env.PORT),
  },
  redis: {
    host: String(process.env.REDIS_HOST),
    port: Number(process.env.REDIS_PORT),
    password: String(process.env.REDIS_PASSWORD),
    connectionPool: Number(process.env.REDIS_POOL_SIZE) || 50,
    featureTimeout: Number(process.env.REDIS_FEATURE_TIMEOUT) || 100,
  },
  database: {
    DB_CLIENT: process.env.DB_CLIENT,
    DB_URL: String(process.env.DB_URL),
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    topic: process.env.KAFKA_TOPIC || "transactions.completed",
    blockedTopic: process.env.KAFKA_BLOCKED_TOPIC || "transactions.blocked",
    consumerGroup: process.env.KAFKA_CONSUMER_GROUP || "pattern-analysis",
    clientId: process.env.KAFKA_CLIENT_ID || "ojuri-rda",
  },
  onnx: {
    modelPath: process.env.MODEL_PATH || "./models/fraud_model.onnx",
    modelPollInterval: Number(process.env.MODEL_POLL_INTERVAL) || 300000,
    sessionPoolSize: ONNX_POOL_SIZE,
    intraOpNumThreads: resolveOnnxIntraOpThreads(ONNX_POOL_SIZE),
  },
  fraud: {
    threshold: Number(process.env.FRAUD_THRESHOLD) || 0.65,
  },
  circuitBreaker: {
    redis: {
      timeout: Number(process.env.CB_REDIS_TIMEOUT) || 100,
      errorThresholdPercentage: Number(process.env.CB_REDIS_ERROR_THRESHOLD) || 50,
      resetTimeout: Number(process.env.CB_REDIS_RESET_TIMEOUT) || 30000,
    },
    onnx: {
      timeout: Number(process.env.CB_ONNX_TIMEOUT) || 100,
      errorThresholdPercentage: Number(process.env.CB_ONNX_ERROR_THRESHOLD) || 10,
      resetTimeout: Number(process.env.CB_ONNX_RESET_TIMEOUT) || 60000,
    },
  },
  paa: {
    graphUpdateInterval: Number(process.env.GRAPH_UPDATE_INTERVAL) || 300000,
    pagerankDamping: Number(process.env.PAGERANK_DAMPING) || 0.85,
    batchSize: Number(process.env.BATCH_SIZE) || 100,
    maxGraphNodes: Number(process.env.MAX_GRAPH_NODES) || 1000000,
  },
};

export default appConfig;
