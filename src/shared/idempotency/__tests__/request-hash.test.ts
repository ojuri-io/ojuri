import "reflect-metadata";
import IdempotencyService from "@shared/idempotency/idempotency.service";

const hash = (body: unknown) => IdempotencyService.hashRequest(body);

describe("hashRequest", () => {
  it("ignores key order, so a retry built from a map is not read as a changed body", () => {
    const sent = {
      transaction_id: "txn-0000000001",
      sender_id: "a",
      receiver_id: "b",
      amount: 100,
      transaction_type: "TRANSFER",
      timestamp: 1,
    };
    const retried = {
      timestamp: 1,
      transaction_type: "TRANSFER",
      amount: 100,
      receiver_id: "b",
      sender_id: "a",
      transaction_id: "txn-0000000001",
    };

    expect(hash(sent)).toBe(hash(retried));
  });

  it("ignores key order inside nested objects and objects in arrays", () => {
    expect(hash({ a: { y: 2, x: 1 }, list: [{ q: 1, p: 2 }] })).toBe(
      hash({ list: [{ p: 2, q: 1 }], a: { x: 1, y: 2 } })
    );
  });

  it("still sees a changed value", () => {
    expect(hash({ amount: 100 })).not.toBe(hash({ amount: 101 }));
  });

  it("still sees an added or removed field", () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 1, b: 2 }));
  });

  it("keeps array order significant, because a reordered list is a different request", () => {
    expect(hash({ codes: ["a", "b"] })).not.toBe(hash({ codes: ["b", "a"] }));
  });

  it("distinguishes a missing field from an explicitly null one", () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 1, b: null }));
  });

  it("handles a null or undefined body without throwing", () => {
    expect(hash(null)).toBe(hash(undefined));
  });
});
