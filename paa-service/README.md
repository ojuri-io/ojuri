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
| `MAX_GRAPH_NODES` | `1000000` | Soft cap on unique user accounts held in the in-memory graph. See "Sizing" below — this is the most consequential knob for memory and the only one that fails silently when undersized. |

In docker-compose PAA is a singleton (`paa-1`) listening on container
port `9090`, published as host `9091`. Do not scale this service —
the graph + velocity state are in-memory, so a second consumer in
the `pattern-analysis` group would split the partition assignment and
fragment graph algorithms across replicas. The `paa_group_members`
metric must stay at 1.

## Sizing

PAA holds the transaction graph and velocity windows in process
memory. Two ceilings matter, and they bind in different orders for
different adopters:

- **Throughput**: how many Kafka events the single consumer can chew
  per second. The Node.js event loop, per-event triangle-close
  detection on high-degree hubs, and the per-event Map.set into the
  Postgres/Redis write buffers all bound this. Practical ceiling
  on commodity hardware is **~500 TPS sustained**. Past that, Kafka
  consumer lag grows without bound.
- **Memory**: how many unique nodes + edges fit in RAM. Each node
  costs ~250 bytes; each edge ~300 bytes; velocity history ~2 KB per
  active user. Default `MAX_GRAPH_NODES=1000000` lines up roughly
  with the `8G` memory limit in `docker-compose.yml`.

A node is one user account — `sender_id` or `receiver_id` from the
Kafka event. That covers customer wallets, agent accounts, merchant
tills, bank settlement accounts, internal float accounts — anything
that can move money.

### What happens at the cap

When the graph is full and a brand-new user transacts,
`pruneOldNodes({ capDriven: true })` fires inline before the new node
is added (`graph.service.ts:65`). It drops the oldest 10% of
`MAX_GRAPH_NODES` (= 100k by default) **of nodes whose `lastSeen` is
older than 30 days**. Two important nuances:

1. **The prune cannot evict still-active users.** If every node in
   the graph has transacted within the last 30 days, nothing is
   eligible — the graph grows past the cap unchecked. The hourly
   scheduled prune has the same constraint.
2. **Dropping a node drops every edge incident to it.** If a long-
   tail counterparty becomes "stale" while one end of an active
   ring still transacts, the ring's structural signal is lost on the
   next compute.

Past the cap with no eligible victims, memory climbs until the
process OOMs (around 2–3M nodes for the default 8 GB limit,
depending on edge density). The orchestrator restarts the
container, PAA replays history, hits the cap again — crash loop.
There is no log line warning that the cap was hit but no prune
happened; **silent degradation is the default failure mode here.**

### Sizing guidance

| Profile | TPS | Active users / 30 d | What to set |
|---|---|---|---|
| Demo / dev | <10 | <10k | Defaults are fine |
| Small fintech | <50 | <100k | Defaults are fine |
| Mid-size lender / regional MMO | <500 | <1M | Defaults are fine; watch `paa_consumer_lag` and `paa_graph_size{type="nodes"}` |
| Large MMO | <500 TPS but >1M active users | 1–5M | Bump `MAX_GRAPH_NODES` proportionally **and** the PAA `memory` limit in `docker-compose.yml` (rule of thumb: +5–8 GB per additional million nodes) |
| Tier-1 (M-Pesa-scale) | >500 TPS or >5M active users | Either bound exceeded | The singleton design ceases to be appropriate; externalize the graph (RedisGraph / Neo4j / Memgraph) with multiple PAA writers and a separate scheduled community-detection worker. Out of scope for this README. |

Monitor `paa_graph_size{type="nodes"}` and `paa_consumer_lag` from
Prometheus — the first warns of memory pressure, the second of CPU
pressure. Either trending upward without bound means you've crossed
a sizing boundary.

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
