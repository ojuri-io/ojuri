/**
 * `reserveTransactionId` claims a transaction_id for the full idempotency
 * TTL (24 h by default) before the prediction runs. With no release path,
 * any 5xx — including the 503 the audit queue raises under backpressure,
 * which clients are expected to retry — left the id claimed, so the retry
 * came back 409 with no cached response to replay.
 */

import "reflect-metadata";
import IdempotencyService from "../../src/shared/idempotency/idempotency.service";

class FakeRedis {
  keys = new Map<string, string>();
  setCalls: Array<{ key: string; args: unknown[] }> = [];
  delCalls: string[] = [];
  failDel = false;

  get() {
    return this as unknown as never;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<string | null> {
    this.setCalls.push({ key, args: _args });
    if (this.keys.has(key)) return null;
    this.keys.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.delCalls.push(key);
    if (this.failDel) throw new Error("redis down");
    return this.keys.delete(key) ? 1 : 0;
  }
}

function makeService(): { svc: IdempotencyService; redis: FakeRedis } {
  const redis = new FakeRedis();
  const svc = new IdempotencyService(redis as unknown as never);
  return { svc, redis };
}

describe("transaction_id reservation lifecycle", () => {
  it("reserves once and rejects the second claim", async () => {
    const { svc } = makeService();
    expect(await svc.reserveTransactionId("acme", "txn-1")).toBe(true);
    expect(await svc.reserveTransactionId("acme", "txn-1")).toBe(false);
  });

  it("releases the reservation so a retry after a failure can proceed", async () => {
    const { svc } = makeService();
    await svc.reserveTransactionId("acme", "txn-1");
    await svc.releaseTransactionId("acme", "txn-1");
    expect(await svc.reserveTransactionId("acme", "txn-1")).toBe(true);
  });

  it("scopes reservations per tenant", async () => {
    const { svc } = makeService();
    await svc.reserveTransactionId("acme", "txn-1");
    expect(await svc.reserveTransactionId("globex", "txn-1")).toBe(true);
  });

  it("releases the same key it reserved", async () => {
    const { svc, redis } = makeService();
    await svc.reserveTransactionId("acme", "txn-1");
    await svc.releaseTransactionId("acme", "txn-1");
    expect(redis.delCalls).toEqual([redis.setCalls[0]!.key]);
  });

  it("swallows Redis failures — release is best-effort, the TTL is the backstop", async () => {
    const { svc, redis } = makeService();
    await svc.reserveTransactionId("acme", "txn-1");
    redis.failDel = true;
    await expect(svc.releaseTransactionId("acme", "txn-1")).resolves.toBeUndefined();
  });
});
