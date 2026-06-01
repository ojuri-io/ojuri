import "reflect-metadata";
import DecisionAuditService from "../../src/shared/audit/decision-audit.service";
import type { RuleExpression } from "../../src/shared/rules/rule.types";

function buildCapturingService() {
  const saved: Array<Record<string, unknown>> = [];
  const repo = {
    async save(rec: Record<string, unknown>) {
      saved.push(rec);
      return { id: `audit-${rec.transactionId}` };
    },
  };
  return { svc: new DecisionAuditService(repo as never), saved };
}

const ruleExpression: RuleExpression = {
  and: [
    { ">=": [{ var: "amount" }, 100_000] },
    { "==": [{ var: "ip_country" }, "NL"] },
  ],
};

const baseRecord = {
  transactionId: "TXN-RULE-SNAPSHOT-001",
  tenantId: "tenant-a",
  senderId: "sender-1",
  amount: 250_000,
  championModelVersion: "v1",
  championScore: 0.42,
  threshold: 0.65,
  mlDecision: "ACCEPT" as const,
  finalDecision: "DECLINE" as const,
  decisionSource: "PRE_RULE" as const,
  latencyMs: 5,
};

describe("DecisionAuditService.record — rule snapshot persistence", () => {
  it("forwards ruleExpression and ruleAction verbatim to the repo", async () => {
    const { svc, saved } = buildCapturingService();
    await svc.record({
      ...baseRecord,
      ruleId: "rule-vpn-hi-amount",
      ruleName: "High amount via VPN",
      ruleStage: "PRE",
      ruleExpression,
      ruleAction: "DENY",
    });

    expect(saved).toHaveLength(1);
    const row = saved[0]!;
    expect(row.ruleId).toBe("rule-vpn-hi-amount");
    expect(row.ruleName).toBe("High amount via VPN");
    expect(row.ruleStage).toBe("PRE");
    expect(row.ruleAction).toBe("DENY");
    expect(row.ruleExpression).toEqual(ruleExpression);
  });

  it("nulls the snapshot columns when no rule fired (ML-only decision)", async () => {
    const { svc, saved } = buildCapturingService();
    await svc.record(baseRecord);

    const row = saved[0]!;
    expect(row.ruleId).toBeNull();
    expect(row.ruleName).toBeNull();
    expect(row.ruleStage).toBeNull();
    expect(row.ruleExpression).toBeNull();
    expect(row.ruleAction).toBeNull();
  });
});
