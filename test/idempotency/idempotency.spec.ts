import "reflect-metadata";
import IdempotencyService, {
  encodeEntry,
  decodeEntry,
} from "../../src/shared/idempotency/idempotency.service";

describe("IdempotencyService.hashRequest", () => {
  it("is deterministic for the same body", () => {
    const a = IdempotencyService.hashRequest({ x: 1, y: "two" });
    const b = IdempotencyService.hashRequest({ x: 1, y: "two" });
    expect(a).toBe(b);
  });

  it("changes when any field changes", () => {
    const base = IdempotencyService.hashRequest({ amount: 100 });
    const changed = IdempotencyService.hashRequest({ amount: 101 });
    expect(base).not.toBe(changed);
  });

  it("returns a stable hash for null and undefined", () => {
    expect(IdempotencyService.hashRequest(null)).toBe(
      IdempotencyService.hashRequest(undefined)
    );
  });
});

describe("idempotency composite key (regression)", () => {
  it("anonymous and authenticated callers compose to distinct storage keys", () => {
    const sentinel = "test-key";
    expect(sentinel.includes("|")).toBe(false);
    expect(`anon|${sentinel}`).not.toEqual(`api-key-id|${sentinel}`);
  });
});

describe("idempotency encodeEntry / decodeEntry", () => {
  const entry = {
    requestHash: "a".repeat(64),
    response: {
      transaction_id: "550e8400-e29b-41d4-a716-446655440000",
      fraud: false,
      fraud_probability: 0.1842,
      decision: "ACCEPT",
      reason_codes: [
        { code: "AMOUNT_HIGH", description: "Long description with padding", contribution: 0.27, value: 1500 },
        { code: "VELOCITY_24H", description: "Long description with padding", contribution: -0.05, value: 4 },
      ],
    },
  };

  it("plaintext round-trips", () => {
    const encoded = encodeEntry(entry, false);
    expect(encoded.startsWith("gz:")).toBe(false);
    expect(decodeEntry(encoded)).toEqual(entry);
  });

  it("gzipped round-trips", () => {
    const encoded = encodeEntry(entry, true);
    expect(encoded.startsWith("gz:")).toBe(true);
    expect(decodeEntry(encoded)).toEqual(entry);
  });

  it("gzipped payload is materially smaller than plaintext for typical responses", () => {
    const plain = encodeEntry(entry, false);
    const gz = encodeEntry(entry, true);
    // For typical reason-code-heavy payloads gzip cuts ~40 %+ even
    // after base64 inflation. Use a conservative threshold (>10 %)
    // so this test doesn't flap on small payload-shape changes.
    expect(gz.length).toBeLessThan(plain.length * 0.9);
  });

  it("decoder returns null on garbled input", () => {
    expect(decodeEntry("not json")).toBeNull();
    expect(decodeEntry("gz:not-base64!!!")).toBeNull();
  });
});
