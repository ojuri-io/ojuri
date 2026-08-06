/**
 * The queue used to `splice` a batch out of the buffer and, on any
 * Postgres error, log "rows dropped" and lose them. Decisions that had
 * already been returned to clients vanished from the audit trail — an
 * at-most-once compliance gap on the record of record.
 */

import "reflect-metadata";
import AuditWriteQueue from "../../src/shared/audit/audit-write-queue";
import { QueuedAuditRecord } from "../../src/shared/audit/decision-audit.types";
import { Decision } from "../../src/shared/enums/decision.enum";
import { DecisionSource } from "../../src/shared/enums/decision-source.enum";

function record(id: string): QueuedAuditRecord {
  return {
    id,
    transactionId: `txn-${id}`,
    senderId: "s",
    amount: 100,
    championModelVersion: "v1",
    championScore: 0.4,
    threshold: 0.65,
    mlDecision: Decision.ACCEPT,
    finalDecision: Decision.ACCEPT,
    decisionSource: DecisionSource.ML,
    latencyMs: 3,
  };
}

type QueueInternals = {
  buffer: QueuedAuditRecord[];
  flush(): Promise<void>;
  opts: { capacity: number; batchSize: number };
};

function internals(q: AuditWriteQueue): QueueInternals {
  return q as unknown as QueueInternals;
}

describe("AuditWriteQueue failure handling", () => {
  it("re-queues a failed batch instead of dropping it", async () => {
    const q = new AuditWriteQueue();
    const inner = internals(q);
    q.enqueue(record("a"));
    q.enqueue(record("b"));

    // No DB is bound in unit tests, so flush() throws on DecisionAudit.knex().
    await inner.flush();

    expect(inner.buffer.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("preserves ordering across repeated failures", async () => {
    const q = new AuditWriteQueue();
    const inner = internals(q);
    ["a", "b", "c"].forEach((id) => q.enqueue(record(id)));

    await inner.flush();
    await inner.flush();

    expect(inner.buffer.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("drops only the overflow when the buffer has no room left", async () => {
    const q = new AuditWriteQueue();
    const inner = internals(q);
    inner.opts.capacity = 2;
    inner.opts.batchSize = 2;
    q.enqueue(record("a"));
    q.enqueue(record("b"));

    await inner.flush();
    expect(inner.buffer).toHaveLength(2);
  });

  it("raises backpressure rather than growing without bound", () => {
    const q = new AuditWriteQueue();
    internals(q).opts.capacity = 1;
    q.enqueue(record("a"));
    expect(() => q.enqueue(record("b"))).toThrow();
  });
});

describe("AuditWriteQueue late-binding patch", () => {
  it("patches a still-buffered row", () => {
    const q = new AuditWriteQueue();
    q.enqueue(record("a"));
    expect(q.patch("a", { shadowScore: 0.81 })).toBe(true);
    expect(internals(q).buffer[0]!.shadowScore).toBe(0.81);
  });

  it("reports false for a row that has already flushed", () => {
    const q = new AuditWriteQueue();
    expect(q.patch("gone", { shadowScore: 0.5 })).toBe(false);
  });
});
