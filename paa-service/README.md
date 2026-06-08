# Pattern Analysis Agent (PAA)

Standalone Kafka consumer worker (TypeScript + KafkaJS). PAA reads
`transactions.completed`, updates an in-memory transaction graph and
velocity windows, then batches writes to Redis and Postgres. **PAA does
not sit on the authorization path** — RDA prediction continues even if
PAA is down; Redis features just go stale until PAA catches up.

## What it does

| Concern | Where |
| --- | --- |
| Kafka consumer (group `pattern-analysis`) | `src/services/kafka-consumer.ts` |
| Transaction graph (graphology, PageRank, clustering, community) | `src/services/graph.service.ts` |
| Velocity windows (1m / 5m / 15m / 1h / 24h / 7d / 30d) | `src/services/velocity.service.ts` |
| Redis writes (batched, per sender) | `src/services/redis-update.service.ts` |
| Postgres writes (graphMetadata, velocitySnapshots) | `src/services/postgres.service.ts` |
| Inline health + metrics HTTP server | `src/worker.ts` |

Graph metadata is snapshotted for both sender and receiver on every
event into an in-memory Map keyed by `userId`, then bulk-upserted to
Postgres on the standard batch flush (size 100 or 10 s). The Map
dedupes hot users so write pressure stays bounded by the unique-user
rate, not the event rate. Redis writes flush on the same cadence so
RDA's next prediction sees the freshest features.

The Redis wire format uses the canonical catalogue feature names
(`graph_pagerank`, `pair_time_since_last_send`, `amount_mean_30d`,
…) — same names MLA's training query expects. See
[`docs/FEATURES.md`](../docs/FEATURES.md) for the full list.

## Running

```bash
cd paa-service
npm install
cp .env.example .env
npm run start:dev          # nodemon hot-reload
npm run build              # tsc to dist/
npm run lint
npm test
```

Path aliases (`@config`, `@services`, `@utils`) resolve via `tsconfig.json`
at compile time and `module-alias` at runtime — they map to
`paa-service/src/*` (different roots from the root RDA `tsconfig.json`,
which maps to `src/*`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka cluster |
| `KAFKA_TOPIC` | `transactions.completed` | Input topic (keyed by `sender_id`) |
| `KAFKA_CONSUMER_GROUP` | `pattern-analysis` | Distinct from `fraud-investigation` (FIA) and `model-learning-v2` (MLA) |
| `KAFKA_CLIENT_ID` | `paa-service` | |
| `DB_URL` | `postgresql://postgres:postgres@localhost:5432/fraud_db` | Shared `fraud_db` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Same Redis RDA reads features from |
| `METRICS_PORT` | `9090` | `/livez`, `/readyz`, `/metrics`, `/stats` |
| `GRAPH_UPDATE_INTERVAL` | `300000` (5 min) | PageRank recompute cadence (ms) |
| `PAGERANK_DAMPING` | `0.85` | Standard damping |
| `BATCH_SIZE` | `100` | Postgres batch flush size |
| `MAX_GRAPH_NODES` | `1000000` | LRU cap on in-memory graph |

In docker-compose PAA is a singleton (`paa-1`) listening on container
port `9090`, published as host `9091`. Do not scale this service —
the graph + velocity state are in-memory, so a second consumer in
the `pattern-analysis` group would split the partition assignment and
fragment graph algorithms across replicas. The `paa_group_members`
metric must stay at 1.

## Health endpoints

The HTTP server is wired inline in `worker.ts` — there is no Fastify
app.

- `GET /livez` — `{"status":"UP"}`
- `GET /readyz` — 200 if Kafka + Postgres are reachable, 503 otherwise
- `GET /metrics` — Prometheus exposition (processing-latency
  histograms, batch counters, graph node/edge counts)
- `GET /stats` — internal counters as JSON

## Failure mode

If PAA crashes or lags, RDA continues to serve `POST /v1/predict`.
Redis features simply stop refreshing, so RDA falls back to the
catalogue default for that sender (and the audit row's
`featuresDefault` is set to `true`). When PAA restarts it resumes from
its committed Kafka offset and catches up.

## Where this fits in the system

PAA is one of four agents documented in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) (§4.2). For the
full data-flow picture — what RDA writes, what PAA reads, what MLA
consumes from the same topic — start there.
