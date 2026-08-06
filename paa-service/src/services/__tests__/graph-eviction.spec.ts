/**
 * MAX_GRAPH_NODES was a soft cap. Cap-driven pruning only ever evicted
 * nodes whose `lastSeen` was past the 30-day staleness cutoff, so a
 * graph at capacity with all-recent nodes evicted nothing and
 * `ensureNode` added the new node regardless — unbounded growth to OOM.
 * Worse, the failed prune walked every node on *every* insert, so
 * throughput collapsed long before memory did.
 */

import GraphService from "../graph.service";
import { TransactionEvent } from "../types";

jest.mock("@config/app.config", () => {
  const actual = jest.requireActual("@config/app.config").default;
  return {
    __esModule: true,
    default: { ...actual, paa: { ...actual.paa, maxGraphNodes: 20 } },
  };
});

jest.mock("@utils/metrics", () => ({
  metricsService: {
    updateGraphSize: jest.fn(),
    recordPagerankComputeTime: jest.fn(),
    recordForcedGraphEviction: jest.fn(),
  },
}));

const NOW = 1_700_000_000_000;

function event(sender: string, receiver: string, timestamp: number): TransactionEvent {
  return {
    transaction_id: `${sender}-${receiver}-${timestamp}`,
    sender_id: sender,
    receiver_id: receiver,
    amount: 100,
    timestamp,
    transaction_type: "TRANSFER",
  } as TransactionEvent;
}

describe("graph node cap", () => {
  it("binds even when every node is recent", () => {
    const graph = new GraphService();
    for (let i = 0; i < 200; i++) {
      graph.addTransaction(event(`s${i}`, `r${i}`, NOW + i));
    }
    // 20 is the mocked cap; eviction frees 10% headroom, so the graph
    // settles at or below the cap rather than growing without bound.
    expect(graph.getStats().nodes).toBeLessThanOrEqual(20);
  });

  it("reports forced eviction of non-stale nodes so the cap is not silently too small", () => {
    const { metricsService } = require("@utils/metrics");
    metricsService.recordForcedGraphEviction.mockClear();

    const graph = new GraphService();
    for (let i = 0; i < 60; i++) {
      graph.addTransaction(event(`s${i}`, `r${i}`, NOW + i));
    }

    expect(metricsService.recordForcedGraphEviction).toHaveBeenCalled();
  });

  it("prefers genuinely stale nodes over recent ones", () => {
    const graph = new GraphService();
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 8; i++) {
      graph.addTransaction(event(`old${i}`, `oldr${i}`, NOW));
    }
    // Jump the clock so the first cohort ages past the staleness cutoff.
    for (let i = 0; i < 3; i++) {
      graph.addTransaction(event(`new${i}`, `newr${i}`, NOW + THIRTY_ONE_DAYS));
    }
    for (let i = 3; i < 12; i++) {
      graph.addTransaction(event(`new${i}`, `newr${i}`, NOW + THIRTY_ONE_DAYS));
    }

    const stats = graph.getStats();
    expect(stats.nodes).toBeLessThanOrEqual(20);
    // The recent cohort must survive; the aged-out one is what goes.
    expect(graph.getNodeSnapshot("new11")).not.toBeNull();
  });
});

describe("metric recompute gating", () => {
  it("does not recompute on every 100th transaction inside the interval", () => {
    const graph = new GraphService();
    const spy = jest.spyOn(graph, "computeNetworkMetrics");

    for (let i = 0; i < 500; i++) {
      graph.addTransaction(event(`a${i % 5}`, `b${i % 5}`, NOW + i));
    }

    // The volume trigger fires at 100/200/300/400/500; with a 30 s gate
    // and a synchronous test loop, at most the first can pass.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});
