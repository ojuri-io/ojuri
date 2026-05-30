import "reflect-metadata";
import DecisionAuditService from "../../src/shared/audit/decision-audit.service";

// Regression guard for the per-tenant transaction_id unique constraint.
// When the audit insert hits PG SQLSTATE 23505 (unique_violation) the
// service must classify it as "duplicate" — not as a generic write
// failure. The predict service relies on this discriminator to skip
// the second Kafka publish / webhook fan-out and bubble a 409 up to
// the caller. A regression that treats the violation as a plain
// failure would silently re-emit decision.created and double-process
// the transaction at PAA / MLA / FIA.

function buildService(repoBehavior: "ok" | "duplicate" | "fail") {
  const repo = {
    async save(rec: { transactionId: string }) {
      if (repoBehavior === "duplicate") {
        const err = new Error("duplicate key value violates unique constraint") as Error & {
          code: string;
        };
        err.code = "23505";
        throw err;
      }
      if (repoBehavior === "fail") {
        throw new Error("connection lost");
      }
      return { id: `audit-${rec.transactionId}` };
    },
  };
  return new DecisionAuditService(repo as never);
}

const baseRecord = {
  transactionId: "TXN-001",
  tenantId: "tenant-a",
  senderId: "sender-1",
  amount: 100,
  championModelVersion: "v1",
  championScore: 0.1,
  threshold: 0.5,
  mlDecision: "ACCEPT" as const,
  finalDecision: "ACCEPT" as const,
  decisionSource: "ML" as const,
  latencyMs: 5,
};

describe("DecisionAuditService.record — unique violation classification", () => {
  it("returns kind=ok with the new id on a clean insert", async () => {
    const svc = buildService("ok");
    const result = await svc.record(baseRecord);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.id).toBe("audit-TXN-001");
  });

  it("returns kind=duplicate when PG raises 23505", async () => {
    const svc = buildService("duplicate");
    const result = await svc.record(baseRecord);
    expect(result.kind).toBe("duplicate");
  });

  it("returns kind=failed on any other repo error", async () => {
    const svc = buildService("fail");
    const result = await svc.record(baseRecord);
    expect(result.kind).toBe("failed");
  });
});
