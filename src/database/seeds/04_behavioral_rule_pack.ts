import { Knex } from "knex";
import { RuleAction } from "../../shared/enums/rule-action.enum";
import { RuleStage } from "../../shared/enums/rule-stage.enum";
import { BehavioralRule } from "../types/behavioral-rule-pack-seed.types";

// PAA-derived signals feeding these rules all default to 0 on a Redis
// cache miss (see models/feature-catalog.v1.json), so the pack stays
// silent until PAA has accumulated real velocity/graph state — no
// cold-start false positives. Both rules exclude agents and corporates:
// mobile-money agents and payroll accounts are legitimately high-velocity
// / high-fan-out, and firing on them dominated the false-positive budget
// in efficacy-validation (Track 2, payroll 24.7% FP before the guards).
const VELOCITY_SPIKE_1H = 15;
const FAN_OUT_RECEIVERS_24H = 12;

export const BEHAVIORAL_RULES: BehavioralRule[] = [
  {
    name: "behavioral: velocity spike (non-agent, non-corporate)",
    description:
      "Individual account sending an unusual burst within the hour — the velocity-anomaly signature the ML model misses on trusted, authenticated sessions. REVIEW routes it to an analyst and generates a label.",
    stage: RuleStage.POST,
    priority: 500,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { ">=": [{ var: "features.velocity_1h" }, VELOCITY_SPIKE_1H] },
        { "==": [{ var: "features.is_agent_assisted" }, 0] },
        { "==": [{ var: "features.customer_is_corporate" }, 0] },
      ],
    },
  },
  {
    name: "behavioral: high fan-out spray (non-agent, non-corporate)",
    description:
      "Individual account paying out to many distinct receivers in 24h — the fan-out signature of a spray or a freshly recruited disburser. REVIEW routes it to an analyst and generates a label.",
    stage: RuleStage.POST,
    priority: 510,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { ">=": [{ var: "features.unique_receivers_24h" }, FAN_OUT_RECEIVERS_24H] },
        { "==": [{ var: "features.is_agent_assisted" }, 0] },
        { "==": [{ var: "features.customer_is_corporate" }, 0] },
      ],
    },
  },
];

export async function seed(knex: Knex): Promise<void> {
  for (const rule of BEHAVIORAL_RULES) {
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
      createdBy: "behavioral-pack-seed",
    });
  }
}
