/**
 * Contract test: every `paa:redis` feature in the shared catalogue
 * must be written to Redis by PAA (sender hash or pair hash), except
 * the ones that structurally need data PAA doesn't have yet. A new
 * catalogue feature sourced from PAA that isn't wired up here fails
 * loudly instead of silently scoring on its default forever.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

jest.useFakeTimers();

import RedisUpdateService from "@services/redis-update.service";
import VelocityService from "@services/velocity.service";
import GraphService from "@services/graph.service";
import { CombinedFeatures, PairFeatures, TransactionEvent } from "@services/types";

const CATALOG_PATH = resolve(__dirname, "../../../../models/feature-catalog.v1.json");

// Not yet computable: fraud-proximity features need the label feedback
// loop into PAA; dispute rate needs a dispute ingestion path.
const KNOWN_UNIMPLEMENTED = new Set([
  "graph_shortest_path_to_fraud",
  "graph_neighborhood_fraud_rate",
  "recipient_dispute_rate",
]);

const combinedFeatures: CombinedFeatures = {
  velocity_1m: 1,
  velocity_5m: 2,
  velocity_15m: 3,
  velocity_1h: 4,
  velocity_24h: 5,
  velocity_7d: 6,
  amount_mean_24h: 100,
  amount_max_24h: 500,
  avg_amount_30d: 90,
  std_amount_30d: 10,
  unique_receivers_24h: 2,
  unique_receivers_7d: 4,
  hour_dev_from_norm: 1.5,
  time_since_last_txn: 60,
  pagerank: 0.001,
  clusteringCoef: 0.2,
  communityId: 7,
  degreeCentrality: 0.01,
  inDegree: 3,
  outDegree: 9,
  isHub: 0,
  recipientLifetimeTxCount: 3,
  updated_at: 0,
};

const pairFeatures: PairFeatures = {
  priorSendCount: 4,
  secondsSincePrevSend: 120,
  roundTripCount30d: 1,
  amountMean30d: 250,
};

function event(overrides: Partial<TransactionEvent>): TransactionEvent {
  return {
    transaction_id: "t1",
    sender_id: "A",
    receiver_id: "B",
    amount: 100,
    transaction_type: "TRANSFER",
    timestamp: 0,
    fraud: false,
    fraud_probability: 0.1,
    decision: "ACCEPT",
    processed_at: 0,
    ...overrides,
  };
}

describe("PAA → Redis feature contract", () => {
  it("writes every paa:redis catalogue feature that has a data source", () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    const expected: string[] = catalog.features
      .filter((f: { source: string }) => f.source === "paa:redis")
      .map((f: { name: string }) => f.name)
      .filter((name: string) => !KNOWN_UNIMPLEMENTED.has(name));

    const service = new RedisUpdateService() as any;
    const written = new Set([
      ...Object.keys(service.featuresToHash(combinedFeatures)),
      ...Object.keys(service.pairFeaturesToHash(pairFeatures)),
    ]);

    const missing = expected.filter((name) => !written.has(name));
    expect(missing).toEqual([]);
  });
});

describe("VelocityService windows and pair metrics", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = 40 * DAY;

  function seed(service: VelocityService): void {
    service.recordTransaction(event({ sender_id: "A", receiver_id: "B", amount: 100, timestamp: now - 30_000 }));
    service.recordTransaction(event({ sender_id: "A", receiver_id: "C", amount: 300, timestamp: now - 10 * 60 * 1000 }));
    service.recordTransaction(event({ sender_id: "A", receiver_id: "B", amount: 200, timestamp: now - 2 * HOUR }));
    service.recordTransaction(event({ sender_id: "A", receiver_id: "D", amount: 900, timestamp: now - 3 * DAY }));
    service.recordTransaction(event({ sender_id: "B", receiver_id: "A", amount: 50, timestamp: now - DAY }));
  }

  it("computes the finer velocity windows and receiver diversity", () => {
    const service = new VelocityService();
    seed(service);
    const metrics = service.calculateMetrics("A", now);

    expect(metrics.velocity_1m).toBe(1);
    expect(metrics.velocity_5m).toBe(1);
    expect(metrics.velocity_15m).toBe(2);
    expect(metrics.velocity_24h).toBe(3);
    expect(metrics.velocity_7d).toBe(4);
    expect(metrics.unique_receivers_24h).toBe(2);
    expect(metrics.unique_receivers_7d).toBe(3);
    expect(metrics.amount_max_24h).toBe(300);
    expect(metrics.amount_mean_24h).toBeCloseTo(200, 5);
  });

  it("computes pair metrics scoped to the (sender, receiver) pair", () => {
    const service = new VelocityService();
    seed(service);
    const pair = service.calculatePairMetrics("A", "B", now);

    expect(pair.forwardCount30d).toBe(2);
    expect(pair.amountMean30d).toBeCloseTo(150, 5);
    expect(pair.roundTripCount30d).toBe(1);
    expect(pair.secondsSincePrevSend).toBe(Math.floor((2 * HOUR - 30_000) / 1000));
  });

  it("returns null gap for a first-time pair", () => {
    const service = new VelocityService();
    seed(service);
    expect(service.calculatePairMetrics("A", "C", now).secondsSincePrevSend).toBeNull();
  });
});

describe("GraphService hub detection", () => {
  it("flags only nodes past the out-degree floor as hubs", () => {
    const service = new GraphService();

    for (let i = 0; i < 12; i++) {
      service.addTransaction(event({ sender_id: "hub", receiver_id: `r${i}`, timestamp: i }));
    }
    service.addTransaction(event({ sender_id: "r1", receiver_id: "r2", timestamp: 20 }));
    service.computeNetworkMetrics();

    expect(service.getNetworkFeatures("hub").isHub).toBe(1);
    expect(service.getNetworkFeatures("r1").isHub).toBe(0);
  });
});
