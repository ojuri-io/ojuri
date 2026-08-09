/**
 * The queue used to `splice` a batch out of the buffer and, on any
 * Postgres error, log "rows dropped" and lose them. Decisions that had
 * already been returned to clients vanished from the audit trail — an
 * at-most-once compliance gap on the record of record.
 */

import "reflect-metadata";
import AuditWriteQueue from "../../src/shared/audit/audit-write-queue";
import { QueuedAuditRecord } from "../../src/shared/audit/decision-audit.types";
import { DecisionAudit } from "../../src/shared/audit/model/decision-audit.model";
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

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres rejected: ${code}`), { code });
}

type QueueInternals = {
  buffer: QueuedAuditRecord[];
  flush(): Promise<void>;
  flushWith(err: Error): Promise<void>;
  opts: { capacity: number; batchSize: number };
};

function internals(q: AuditWriteQueue): QueueInternals {
  const inner = q as unknown as QueueInternals;
  // No DB is bound in unit tests, so plain flush() already throws. This
  // lets a test choose *which* error Postgres returns.
  inner.flushWith = async (err: Error) => {
    const knex = (DecisionAudit as unknown as { knex: () => unknown }).knex;
    (DecisionAudit as unknown as { knex: () => unknown }).knex = () => {
      throw err;
    };
    try {
      await inner.flush();
    } finally {
      (DecisionAudit as unknown as { knex: () => unknown }).knex = knex;
    }
  };
  return inner;
}

describe("AuditWriteQueue poison handling", () => {
  // Retrying a batch Postgres will never accept blocks the queue head,
  // fills the buffer, and makes enqueue() throw — turning an audit
  // outage into a total outage of the decision path. The trigger is
  // mundane: deploying code before its migration.
  it("drops a batch rejected for a permanent reason instead of blocking the head", async () => {
    const q = new AuditWriteQueue();
    const inner = internals(q);
    q.enqueue(record("a"));

    await inner.flushWith(pgError("42703")); // undefined_column

    expect(inner.buffer).toHaveLength(0);
  });

  it("re-queues on connection and resource failures", async () => {
    for (const code of ["08006", "53300", "57P01", "40001"]) {
      const q = new AuditWriteQueue();
      const inner = internals(q);
      q.enqueue(record("a"));

      await inner.flushWith(pgError(code));

      expect(inner.buffer.map((r) => r.id)).toEqual(["a"]);
    }
  });

  it("re-queues errors that carry no SQLSTATE, which are usually socket failures", async () => {
    const q = new AuditWriteQueue();
    const inner = internals(q);
    q.enqueue(record("a"));

    await inner.flushWith(new Error("read ECONNRESET"));

    expect(inner.buffer).toHaveLength(1);
  });
});

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
