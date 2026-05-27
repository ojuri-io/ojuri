import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Smoke-tests `data/demo/sample-transactions.json` so a careless edit
 * (typo, wrong enum, missing core-8 field) can't break `npm run demo:load`
 * without a CI signal. Doesn't verify the *decision shape* the entries
 * are meant to elicit — that depends on the active model and rules —
 * just that each payload is well-formed enough that the predict
 * endpoint will accept it.
 */

const VALID_TRANSACTION_TYPES = new Set([
  "CASH_IN",
  "CASH_OUT",
  "PAYMENT",
  "TRANSFER",
  "DEBIT",
]);

const REQUIRED_FIELDS = [
  "transaction_id",
  "sender_id",
  "receiver_id",
  "amount",
  "transaction_type",
  "timestamp",
];

interface DemoEntry extends Record<string, unknown> {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: string;
  timestamp: number;
}

const datasetPath = resolve(__dirname, "../../data/demo/sample-transactions.json");

describe("data/demo/sample-transactions.json", () => {
  let entries: DemoEntry[];

  beforeAll(() => {
    const raw = readFileSync(datasetPath, "utf8");
    entries = JSON.parse(raw) as DemoEntry[];
  });

  it("is a non-empty JSON array", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("each entry carries the core-8 required fields", () => {
    for (const [i, entry] of entries.entries()) {
      for (const field of REQUIRED_FIELDS) {
        expect({ index: i, field, hasField: field in entry }).toEqual({
          index: i,
          field,
          hasField: true,
        });
      }
    }
  });

  it("each transaction_type is in the allowed enum", () => {
    for (const [i, entry] of entries.entries()) {
      expect({ index: i, transaction_type: entry.transaction_type, valid: VALID_TRANSACTION_TYPES.has(entry.transaction_type) }).toEqual({
        index: i,
        transaction_type: entry.transaction_type,
        valid: true,
      });
    }
  });

  it("each amount is a positive finite number", () => {
    for (const [i, entry] of entries.entries()) {
      expect({ index: i, amount: entry.amount, valid: Number.isFinite(entry.amount) && entry.amount > 0 }).toEqual({
        index: i,
        amount: entry.amount,
        valid: true,
      });
    }
  });

  it("each timestamp is a plausible unix-seconds value", () => {
    // Anything from 2020-01-01 onwards is fine; the seed-load script
    // rewrites timestamps on send anyway, but a clearly-broken value
    // (e.g. milliseconds, or 0) suggests a copy-paste mistake worth
    // catching at edit time.
    const FLOOR = 1577836800; // 2020-01-01T00:00:00Z
    const CEIL = 4102444800;  // 2100-01-01T00:00:00Z
    for (const [i, entry] of entries.entries()) {
      expect({ index: i, timestamp: entry.timestamp, plausible: entry.timestamp >= FLOOR && entry.timestamp <= CEIL }).toEqual({
        index: i,
        timestamp: entry.timestamp,
        plausible: true,
      });
    }
  });

  it("transaction_id values are unique within the file", () => {
    const ids = entries.map((e) => e.transaction_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all three decision buckets via _note hints", () => {
    // Each entry has a `_note` describing its intended decision bucket
    // ("ACCEPT", "REVIEW", "DECLINE"). Confirm at least one of each
    // exists so the demo actually shows the dashboard's three states.
    const notes = entries
      .map((e) => String(e._note ?? "").toUpperCase())
      .filter((n) => n.length > 0);
    expect(notes.some((n) => n.includes("ACCEPT"))).toBe(true);
    expect(notes.some((n) => n.includes("REVIEW"))).toBe(true);
    expect(notes.some((n) => n.includes("DECLINE"))).toBe(true);
  });
});
