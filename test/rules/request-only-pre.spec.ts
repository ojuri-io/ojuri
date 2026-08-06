/**
 * Every PRE rule shipped in the seed packs reads request fields only, so
 * the Redis feature load (19 ms mean under contention) was pure waste on
 * any request a PRE rule was about to decline. Splitting the pass must
 * not change *which* rule wins: a request-only hit may short-circuit only
 * when it outranks every feature-dependent PRE rule.
 */

import "reflect-metadata";
import RulesService from "../../src/shared/rules/rules.service";
import { RuleAction } from "../../src/shared/enums/rule-action.enum";
import { RuleContext, RuleExpression } from "../../src/shared/rules/rule.types";
import { TransactionType } from "../../src/shared/enums/transaction-type.enum";

interface SeedRule {
  id: string;
  name: string;
  priority: number;
  expression: RuleExpression;
  stage?: string;
}

function makeService(rules: SeedRule[]): RulesService {
  const rows = rules.map((r) => ({
    id: r.id,
    name: r.name,
    description: null,
    stage: r.stage ?? "PRE",
    priority: r.priority,
    action: RuleAction.DECLINE,
    expression: r.expression,
    isActive: true,
    tenantId: null,
  }));
  const repo = { listActiveOrdered: async () => rows } as never;
  return new RulesService(repo, {} as never);
}

const ctx: RuleContext = {
  transaction_id: "t",
  sender_id: "s",
  receiver_id: "r",
  amount: 900_000,
  transaction_type: TransactionType.TRANSFER,
  timestamp: 0,
  ip_is_vpn: true,
};

describe("request-only PRE classification", () => {
  it("classifies rules by whether they read a features.* path", async () => {
    const svc = makeService([
      { id: "1", name: "request", priority: 10, expression: { ">=": [{ var: "amount" }, 1] } },
      {
        id: "2",
        name: "feature",
        priority: 20,
        expression: { ">=": [{ var: "features.velocity_1h" }, 1] },
      },
    ]);
    await svc.reload();

    const records = (svc as unknown as { preRules: Array<{ name: string; requestOnly: boolean }> })
      .preRules;
    expect(records.find((r) => r.name === "request")!.requestOnly).toBe(true);
    expect(records.find((r) => r.name === "feature")!.requestOnly).toBe(false);
  });

  it("short-circuits before the feature load when nothing feature-dependent outranks it", async () => {
    const svc = makeService([
      { id: "1", name: "vpn", priority: 10, expression: { "==": [{ var: "ip_is_vpn" }, true] } },
      {
        id: "2",
        name: "velocity",
        priority: 50,
        expression: { ">=": [{ var: "features.velocity_1h" }, 1] },
      },
    ]);
    await svc.reload();

    expect(svc.evaluateRequestOnlyPre(ctx)?.rule.name).toBe("vpn");
  });

  // Without the priority guard this would return "vpn", overturning the
  // ordering the full pass guarantees.
  it("defers when a higher-priority feature rule could still win", async () => {
    const svc = makeService([
      {
        id: "1",
        name: "velocity",
        priority: 10,
        expression: { ">=": [{ var: "features.velocity_1h" }, 1] },
      },
      { id: "2", name: "vpn", priority: 50, expression: { "==": [{ var: "ip_is_vpn" }, true] } },
    ]);
    await svc.reload();

    expect(svc.evaluateRequestOnlyPre(ctx)).toBeNull();
    expect(svc.evaluate("PRE" as never, { ...ctx, features: { velocity_1h: 0 } })?.rule.name).toBe(
      "vpn"
    );
  });

  it("defers on an equal-priority tie, where createdAt decides", async () => {
    const svc = makeService([
      { id: "1", name: "vpn", priority: 10, expression: { "==": [{ var: "ip_is_vpn" }, true] } },
      {
        id: "2",
        name: "velocity",
        priority: 10,
        expression: { ">=": [{ var: "features.velocity_1h" }, 1] },
      },
    ]);
    await svc.reload();

    expect(svc.evaluateRequestOnlyPre(ctx)).toBeNull();
  });

  it("returns null when no request-only rule matches", async () => {
    const svc = makeService([
      { id: "1", name: "huge", priority: 10, expression: { ">=": [{ var: "amount" }, 10_000_000] } },
    ]);
    await svc.reload();

    expect(svc.evaluateRequestOnlyPre(ctx)).toBeNull();
  });

  it("ignores POST rules entirely", async () => {
    const svc = makeService([
      {
        id: "1",
        name: "post",
        priority: 1,
        stage: "POST",
        expression: { "==": [{ var: "ip_is_vpn" }, true] },
      },
    ]);
    await svc.reload();

    expect(svc.evaluateRequestOnlyPre(ctx)).toBeNull();
  });
});
