import "reflect-metadata";
import PredictController from "../../src/v1/modules/rda/controller/predict.controller";

// Regression coverage for the audit finding: the override route must
// ignore `reviewer` in the request body and use the authenticated JWT
// subject's username. Without this, any user with `review_queue:override`
// could pin a fraudulent override on a colleague (audit-log forgery).

function buildController() {
  const audit = {
    async override({ auditId, decision, reviewer, reason }: {
      auditId: string;
      decision: string;
      reviewer: string;
      reason?: string;
    }) {
      // Record what the SERVICE was given so the test can assert
      // it matches the JWT subject, not the body.
      audit.lastCall = { auditId, decision, reviewer, reason };
      return {
        id: auditId,
        transactionId: "txn-1",
        tenantId: "default",
        finalDecision: "ACCEPT",
      };
    },
    lastCall: undefined as
      | { auditId: string; decision: string; reviewer: string; reason?: string }
      | undefined,
  };
  const webhooks = { publish: async () => undefined };
  return {
    audit,
    controller: new PredictController(
      {} as never,
      audit as never,
      webhooks as never
    ),
  };
}

function buildReq(opts: {
  auditId: string;
  body: Record<string, unknown>;
  authUsername?: string;
}) {
  return {
    params: { auditId: opts.auditId },
    body: opts.body,
    auth: opts.authUsername
      ? { username: opts.authUsername, userId: "u-1", tenantId: "default", permissions: ["*"] }
      : undefined,
  } as never;
}

function buildRes() {
  const calls: { code?: number; body?: unknown } = {};
  const res = {
    code(c: number) {
      calls.code = c;
      return res;
    },
    send(b: unknown) {
      calls.body = b;
      return res;
    },
  };
  return { res: res as never, calls };
}

describe("overrideDecision — reviewer comes from JWT, not the body", () => {
  it("uses req.auth.username and IGNORES body.reviewer", async () => {
    const { audit, controller } = buildController();
    const { res, calls } = buildRes();

    await controller.overrideDecision(
      buildReq({
        auditId: "a-1",
        body: { decision: "ACCEPT", reviewer: "alice-the-attacker", reason: "test" },
        authUsername: "bob-the-real-user",
      }),
      res
    );

    expect(calls.code).toBeUndefined(); // 200 default
    expect(audit.lastCall?.reviewer).toBe("bob-the-real-user");
    expect(audit.lastCall?.reviewer).not.toBe("alice-the-attacker");
  });

  it("returns 401 when the request is not authenticated", async () => {
    const { controller } = buildController();
    const { res, calls } = buildRes();

    await controller.overrideDecision(
      buildReq({
        auditId: "a-2",
        body: { decision: "DECLINE", reviewer: "anyone" },
        // No authUsername → req.auth absent
      }),
      res
    );

    expect(calls.code).toBe(401);
  });

  it("rejects decisions outside the ACCEPT|DECLINE enum", async () => {
    const { controller } = buildController();
    const { res, calls } = buildRes();

    await controller.overrideDecision(
      buildReq({
        auditId: "a-3",
        body: { decision: "WAFFLE", reviewer: "ignored" },
        authUsername: "bob",
      }),
      res
    );

    expect(calls.code).toBe(400);
  });
});
