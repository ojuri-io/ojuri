import "reflect-metadata";
import PredictController from "../../src/v1/modules/rda/controller/predict.controller";

function buildController(row: Record<string, unknown> | null) {
  const audit = {
    async getByTransactionId(_id: string) {
      return row;
    },
  };
  return new PredictController({} as never, audit as never, {} as never);
}

function buildReq(transactionId: string) {
  return { params: { transactionId } } as never;
}

function buildRes() {
  const captured: { status: number | null; payload: unknown } = {
    status: null,
    payload: undefined,
  };
  const res = {
    code(c: number) {
      captured.status = c;
      return res;
    },
    send(p: unknown) {
      captured.payload = p;
      return res;
    },
  };
  return { res, captured };
}

describe("GET /v1/decisions/:transactionId — rule-snapshot exposure", () => {
  it("includes ruleId / ruleName / ruleStage / ruleAction / ruleExpression in the response", async () => {
    const ruleExpression = {
      and: [
        { ">=": [{ var: "amount" }, 100_000] },
        { "==": [{ var: "ip_country" }, "NL"] },
      ],
    };
    const row = {
      id: "audit-1",
      transactionId: "TXN-001",
      finalDecision: "DECLINE",
      decisionSource: "PRE_RULE",
      ruleId: "rule-1",
      ruleName: "High amount via VPN",
      ruleStage: "PRE",
      ruleAction: "DENY",
      ruleExpression,
    };
    const controller = buildController(row);
    const { res, captured } = buildRes();
    await controller.getDecision(buildReq("TXN-001"), res as never);

    const payload = captured.payload as { data: Record<string, unknown> };
    const data = payload.data;
    expect(data.transactionId).toBe("TXN-001");
    expect(data.ruleId).toBe("rule-1");
    expect(data.ruleName).toBe("High amount via VPN");
    expect(data.ruleStage).toBe("PRE");
    expect(data.ruleAction).toBe("DENY");
    expect(data.ruleExpression).toEqual(ruleExpression);
  });

  it("returns 404 when no audit row exists for the transaction id", async () => {
    const controller = buildController(null);
    const { res, captured } = buildRes();
    await controller.getDecision(buildReq("MISSING"), res as never);
    expect(captured.status).toBe(404);
  });
});
