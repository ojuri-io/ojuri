import { loadCatalog } from "@shared/features/feature-catalog";
import { buildFeatures } from "@shared/features/feature-builder";

describe("feature-builder calendar features", () => {
  const catalog = loadCatalog();

  // 2026-07-06T14:30:00Z — a Monday, day-of-month 6.
  const TS_MS = Date.UTC(2026, 6, 6, 14, 30, 0);

  const request = {
    transaction_id: "test-txn-0001",
    sender_id: "s1",
    receiver_id: "r1",
    amount: 1000,
    transaction_type: "TRANSFER",
    timestamp: TS_MS,
  };

  const snapshotFor = (req: Record<string, unknown>) =>
    buildFeatures(catalog, req, {}).snapshot;

  it("derives hour_of_day from the millisecond timestamp", () => {
    expect(snapshotFor(request).hour_of_day).toBe(14);
  });

  it("derives day_of_week and is_weekend from the millisecond timestamp", () => {
    const snap = snapshotFor(request);
    expect(snap.day_of_week).toBe(1);
    expect(snap.is_weekend).toBe(0);
  });

  it("marks a Saturday-night transaction as weekend and off-hours", () => {
    // 2026-07-04T23:10:00Z — a Saturday.
    const snap = snapshotFor({ ...request, timestamp: Date.UTC(2026, 6, 4, 23, 10, 0) });
    expect(snap.day_of_week).toBe(6);
    expect(snap.is_weekend).toBe(1);
    expect(snap.is_off_hours).toBe(1);
  });

  it("marks the payday window from the day of month", () => {
    const inWindow = snapshotFor({ ...request, timestamp: Date.UTC(2026, 6, 25, 12, 0, 0) });
    const outOfWindow = snapshotFor({ ...request, timestamp: Date.UTC(2026, 6, 10, 12, 0, 0) });
    expect(inWindow.is_payday_window).toBe(1);
    expect(outOfWindow.is_payday_window).toBe(0);
  });

  it("falls back to the provided clock when timestamp is absent", () => {
    const { timestamp: _omitted, ...noTs } = request;
    const snap = buildFeatures(catalog, noTs, {}, Date.UTC(2026, 6, 6, 9, 0, 0)).snapshot;
    expect(snap.hour_of_day).toBe(9);
  });
});
