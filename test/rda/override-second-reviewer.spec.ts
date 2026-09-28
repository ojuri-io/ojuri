import "reflect-metadata";
import PredictController from "../../src/v1/modules/rda/controller/predict.controller";

/**
 * A row can only be reviewed once. Before the guard, a second reviewer's patch
 * replaced the first with no record that it happened, on a table an auditor
 * reads, and fired its own webhook and ground-truth label.
 */
interface Reply {
  status: number | null;
  body: unknown;
  code(status: number): Reply;
  send(body: unknown): Reply;
  header(): Reply;
}

function reply(): Reply {
  const r: Reply = {
    status: null,
    body: null,
    code(status) {
      r.status = status;
      return r;
    },
    send(body) {
      r.body = body;
      return r;
    },
    header() {
      return r;
    },
  };
  return r;
}

function controllerFor(outcome: unknown, publishes: string[]) {
  const audit = { override: async () => outcome };
  const webhooks = {
    publish: async (event: string) => {
      publishes.push(event);
    },
  };
  return new PredictController(
    {} as never,
    audit as never,
    webhooks as never
  );
}

const request = {
  params: { auditId: "audit-1" },
  body: { decision: "ACCEPT" as const },
  auth: { username: "second-reviewer" },
};

describe("a second override on an already-reviewed row", () => {
  it("is refused with a conflict rather than silently replacing the first", async () => {
    const res = reply();
    const controller = controllerFor(
      { kind: "already-reviewed", row: { reviewedBy: "first-reviewer" } },
      []
    );

    await controller.overrideDecision(request as never, res as never);

    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe("already_reviewed");
  });

  it("names who reviewed it, so the second reviewer knows where to look", async () => {
    const res = reply();
    const controller = controllerFor(
      { kind: "already-reviewed", row: { reviewedBy: "first-reviewer" } },
      []
    );

    await controller.overrideDecision(request as never, res as never);

    expect((res.body as { message: string }).message).toContain("first-reviewer");
  });

  it("fires no webhook, because the event already went out for the first review", async () => {
    const publishes: string[] = [];
    const controller = controllerFor(
      { kind: "already-reviewed", row: { reviewedBy: "first-reviewer" } },
      publishes
    );

    await controller.overrideDecision(request as never, reply() as never);

    expect(publishes).toEqual([]);
  });

  it("still publishes when the override did apply", async () => {
    const publishes: string[] = [];
    const controller = controllerFor(
      {
        kind: "applied",
        row: { id: "audit-1", transactionId: "txn-1", tenantId: "default", finalDecision: "DECLINE" },
      },
      publishes
    );

    await controller.overrideDecision(request as never, reply() as never);

    expect(publishes).toEqual(["decision.overridden"]);
  });

  it("still reports a missing row as not found", async () => {
    const res = reply();
    const controller = controllerFor({ kind: "not-found" }, []);

    await controller.overrideDecision(request as never, res as never);

    expect(res.status).toBe(404);
  });
});
