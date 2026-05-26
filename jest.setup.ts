// Ensure the test process has the minimum env required for modules that
// initialize at import time (knex, dotenv-dependent config). Adopters can
// still set these via a `.env` file; this file just guarantees a working
// baseline so `npm test` does not require a checkout-side `.env`.

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DB_CLIENT = process.env.DB_CLIENT ?? "postgres";
process.env.DB_HOST = process.env.DB_HOST ?? "localhost";
process.env.DB_PORT = process.env.DB_PORT ?? "5433";
process.env.DB_DATABASE = process.env.DB_DATABASE ?? "fraud_db";
process.env.DB_USERNAME = process.env.DB_USERNAME ?? "postgres";
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? "postgres";
process.env.DB_URL =
  process.env.DB_URL ?? "postgresql://postgres:postgres@localhost:5433/fraud_db";
process.env.REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
process.env.REDIS_PORT = process.env.REDIS_PORT ?? "6380";
process.env.KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
process.env.AUTH_JWT_SECRET =
  process.env.AUTH_JWT_SECRET ?? "test-secret-min-32-characters-please-change";
process.env.SENTINEL_CORS_ORIGINS =
  process.env.SENTINEL_CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000";
