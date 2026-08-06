/**
 * PAA commits offsets after processing, so a crash in between replays
 * events into in-memory graph/velocity state that already counted them.
 * Postgres upserts are conflict-safe; memory is not, so the inflation is
 * permanent. The producer's LevelDB buffer replay is the same exposure.
 */

import ProcessedEventsService from "../processed-events.service";

jest.mock("@utils/metrics", () => ({
  metricsService: { recordDuplicateEventSkipped: jest.fn() },
}));

describe("ProcessedEventsService", () => {
  it("admits an id once and rejects the replay", () => {
    const tracker = new ProcessedEventsService(100);
    expect(tracker.markIfNew("txn-1")).toBe(true);
    expect(tracker.markIfNew("txn-1")).toBe(false);
  });

  it("counts the skip so replay volume is observable", () => {
    const { metricsService } = require("@utils/metrics");
    metricsService.recordDuplicateEventSkipped.mockClear();

    const tracker = new ProcessedEventsService(100);
    tracker.markIfNew("txn-1");
    tracker.markIfNew("txn-1");

    expect(metricsService.recordDuplicateEventSkipped).toHaveBeenCalledTimes(1);
  });

  it("treats distinct ids independently", () => {
    const tracker = new ProcessedEventsService(100);
    expect(tracker.markIfNew("a")).toBe(true);
    expect(tracker.markIfNew("b")).toBe(true);
  });

  it("evicts oldest-first and stays bounded", () => {
    const tracker = new ProcessedEventsService(3);
    ["a", "b", "c", "d"].forEach((id) => tracker.markIfNew(id));

    expect(tracker.size()).toBe(3);
    // "a" fell out of the window, so it is admitted again.
    expect(tracker.markIfNew("a")).toBe(true);
    expect(tracker.markIfNew("d")).toBe(false);
  });

  it("admits events with no transaction_id rather than collapsing them together", () => {
    const tracker = new ProcessedEventsService(10);
    expect(tracker.markIfNew(undefined)).toBe(true);
    expect(tracker.markIfNew(undefined)).toBe(true);
  });
});
