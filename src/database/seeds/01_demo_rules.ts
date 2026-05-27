import { Knex } from "knex";

/**
 * Demo rules seed — paired with `data/demo/sample-transactions.json` so
 * that `npm run demo:load` produces a visible ACCEPT / REVIEW / DECLINE
 * split in the Sentinel dashboard out of the box, even on a fresh
 * deployment with no PAA cache or Redis feature data.
 *
 * The four rules below use only the core PredictRequestDto fields
 * (amount, transaction_type, segment) that the rules engine has
 * unconditional access to — they don't depend on Redis-stored
 * features. Production users would replace these with their own
 * tenant-specific business rules.
 *
 * Idempotent: each rule is keyed by `name`; running the seed twice
 * does not duplicate rows.
 */

interface DemoRule {
  name: string;
  description: string;
  stage: "PRE" | "POST";
  priority: number;
  action: "ALLOW" | "DENY" | "REVIEW" | "NONE";
  expression: Record<string, unknown>;
}

const DEMO_RULES: DemoRule[] = [
  {
    name: "demo: very-large amount auto-block",
    description: "Block any transaction at or above $100k. Hard ceiling that doesn't need ML.",
    stage: "PRE",
    priority: 100,
    action: "DENY",
    expression: { ">=": [{ var: "amount" }, 100000] },
  },
  {
    name: "demo: high-value mid-size block",
    description: "Block mid-size transactions ($3k+) on the high-value segment.",
    stage: "PRE",
    priority: 200,
    action: "DENY",
    expression: {
      and: [
        { ">=": [{ var: "amount" }, 3000] },
        { "==": [{ var: "segment" }, "high_value"] },
      ],
    },
  },
  {
    name: "demo: high-value moderate-size review",
    description: "Send moderate transactions ($500+) on the high-value segment to manual review.",
    stage: "PRE",
    priority: 300,
    action: "REVIEW",
    expression: {
      and: [
        { ">=": [{ var: "amount" }, 500] },
        { "==": [{ var: "segment" }, "high_value"] },
      ],
    },
  },
  {
    name: "demo: moderate payment review",
    description: "Review standard-segment payments between $500 and $10k — covers the unfamiliar-merchant case.",
    stage: "PRE",
    priority: 400,
    action: "REVIEW",
    expression: {
      and: [
        { ">=": [{ var: "amount" }, 500] },
        { "<": [{ var: "amount" }, 10000] },
        { "==": [{ var: "transaction_type" }, "PAYMENT" ] },
      ],
    },
  },
];

export async function seed(knex: Knex): Promise<void> {
  for (const rule of DEMO_RULES) {
    const existing = await knex("rules").where({ name: rule.name }).first();
    if (existing) continue;
    await knex("rules").insert({
      name: rule.name,
      description: rule.description,
      stage: rule.stage,
      priority: rule.priority,
      action: rule.action,
      expression: JSON.stringify(rule.expression),
      isActive: true,
      createdBy: "demo-seed",
    });
  }
}
