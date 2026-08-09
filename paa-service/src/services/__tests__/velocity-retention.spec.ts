/**
 * Velocity retention was a 1000-record count-based FIFO evaluated against
 * windows up to 30 days, so `amount_mean_30d` / `velocity_7d` were
 * computed on a truncated tail for exactly the highest-velocity senders.
 * Records also arrived append-only and were sorted only at read time, so
 * a late-arriving event evicted the *newest* record rather than the
 * oldest.
 */

import VelocityService from "../velocity.service";
import { TransactionEvent } from "../types";

jest.mock("@utils/metrics", () => ({
  metricsService: { recordVelocityTruncation: jest.fn() },
}));

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function event(sender: string, timestamp: number, amount = 100, receiver = "r"): TransactionEvent {
  return {
    transaction_id: `${sender}-${timestamp}`,
    sender_id: sender,
    receiver_id: receiver,
    amount,
    timestamp,
    transaction_type: "TRANSFER",
  } as TransactionEvent;
}

describe("velocity retention", () => {
  it("keeps a high-velocity sender's full 7-day window past the old 1000-record cap", () => {
    const svc = new VelocityService();
    for (let i = 0; i < 3000; i++) {
      svc.recordTransaction(event("hot", NOW - 6 * DAY + i * 1000));
    }

    const metrics = svc.calculateMetrics("hot", NOW);
    expect(metrics.velocity_7d).toBe(3000);
  });

  it("computes the 30-day mean over every retained record, not the last 1000", () => {
    const svc = new VelocityService();
    // 2000 cheap, then 2000 expensive. A 1000-record tail would report
    // only the expensive half.
    for (let i = 0; i < 2000; i++) svc.recordTransaction(event("hot", NOW - 20 * DAY + i * 1000, 10));
    for (let i = 0; i < 2000; i++) svc.recordTransaction(event("hot", NOW - 10 * DAY + i * 1000, 90));

    expect(svc.calculateMetrics("hot", NOW).avg_amount_30d).toBeCloseTo(50, 1);
  });

  it("evicts by time, dropping records past the 30-day window", () => {
    const svc = new VelocityService();
    svc.recordTransaction(event("u", NOW - 40 * DAY));
    svc.recordTransaction(event("u", NOW - 2 * DAY));

    const metrics = svc.calculateMetrics("u", NOW);
    expect(metrics.velocity_7d).toBe(1);
    expect(metrics.avg_amount_30d).toBe(100);
  });

  it("places a late-arriving event by timestamp instead of evicting the newest", () => {
    const svc = new VelocityService();
    svc.recordTransaction(event("u", NOW - 1000, 10));
    svc.recordTransaction(event("u", NOW, 20));
    // Out-of-order delivery — older than both records already stored.
    svc.recordTransaction(event("u", NOW - 5000, 30));

    const metrics = svc.calculateMetrics("u", NOW);
    expect(metrics.velocity_24h).toBe(3);
    // time_since_last_txn must track the genuinely newest record.
    expect(metrics.time_since_last_txn).toBe(0);
  });

  it("still reports counts per window boundary", () => {
    const svc = new VelocityService();
    svc.recordTransaction(event("u", NOW - 30 * 1000));
    svc.recordTransaction(event("u", NOW - 10 * 60 * 1000));
    svc.recordTransaction(event("u", NOW - 3 * 60 * 60 * 1000));
    svc.recordTransaction(event("u", NOW - 3 * DAY));

    const m = svc.calculateMetrics("u", NOW);
    expect(m.velocity_1m).toBe(1);
    expect(m.velocity_15m).toBe(2);
    expect(m.velocity_1h).toBe(2);
    expect(m.velocity_24h).toBe(3);
    expect(m.velocity_7d).toBe(4);
  });

  it("records a metric when the memory backstop truncates", () => {
    const { metricsService } = require("@utils/metrics");
    metricsService.recordVelocityTruncation.mockClear();

    const svc = new VelocityService();
    (svc as unknown as { maxTransactionsPerUser: number }).maxTransactionsPerUser = 5;
    for (let i = 0; i < 20; i++) svc.recordTransaction(event("u", NOW - 1000 * (20 - i)));

    expect(metricsService.recordVelocityTruncation).toHaveBeenCalled();
  });

  it("keeps pair metrics ordered newest-first for seconds-since-previous-send", () => {
    const svc = new VelocityService();
    svc.recordTransaction(event("s", NOW - 60_000, 10, "r"));
    svc.recordTransaction(event("s", NOW, 10, "r"));

    const pair = svc.calculatePairMetrics("s", "r", NOW);
    expect(pair.forwardCount30d).toBe(2);
    expect(pair.secondsSincePrevSend).toBe(60);
  });
});
