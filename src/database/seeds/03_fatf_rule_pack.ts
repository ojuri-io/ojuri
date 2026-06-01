import { Knex } from "knex";
import { TransactionType } from "../../shared/enums/transaction-type.enum";
import { RuleAction } from "../../shared/enums/rule-action.enum";
import { RuleStage } from "../../shared/enums/rule-stage.enum";
import { FatfRule } from "../types/fatf-rule-pack-seed.types";

const HIGH_RISK_DESTINATION_COUNTRIES: string[] = ["IR", "KP", "MM", "SY", "BY"];

const STRUCTURING_LOWER = 4_500_000;
const STRUCTURING_UPPER = 4_999_999;
const VPN_SIGNIFICANT_AMOUNT = 100_000;
const ATO_HIGH_AMOUNT = 1_000_000;
const UNTRUSTED_DEVICE_AMOUNT = 200_000;

export const FATF_RULES: FatfRule[] = [
  {
    name: "fatf: structuring under cash-reporting threshold",
    description:
      "CASH_OUT sized just under the cash transaction reporting threshold. Defaults are tuned for the Nigerian ₦5M CTR (NFIU). Edit bounds for your jurisdiction.",
    stage: RuleStage.PRE,
    priority: 110,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { "==": [{ var: "transaction_type" }, TransactionType.CASH_OUT] },
        { ">=": [{ var: "amount" }, STRUCTURING_LOWER] },
        { "<=": [{ var: "amount" }, STRUCTURING_UPPER] },
      ],
    },
  },
  {
    name: "fatf: VPN with significant amount",
    description:
      "VPN session on a non-trivial transaction. Default significance threshold tuned for Nigerian retail; edit per market.",
    stage: RuleStage.PRE,
    priority: 115,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { "==": [{ var: "ip_is_vpn" }, true] },
        { ">=": [{ var: "amount" }, VPN_SIGNIFICANT_AMOUNT] },
      ],
    },
  },
  {
    name: "fatf: TRANSFER to FATF high-risk corridor",
    description:
      "Outbound TRANSFER to a FATF black/grey-list jurisdiction. List is global; extend with your own country risk additions.",
    stage: RuleStage.PRE,
    priority: 120,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { "==": [{ var: "transaction_type" }, TransactionType.TRANSFER] },
        { in: [{ var: "destination_country" }, HIGH_RISK_DESTINATION_COUNTRIES] },
      ],
    },
  },
  {
    name: "fatf: account-takeover signature",
    description:
      "Rushed session (≤10s), high amount, IP country differs from transaction country. ATO-shaped behaviour; deny outright.",
    stage: RuleStage.PRE,
    priority: 130,
    action: RuleAction.DENY,
    expression: {
      and: [
        { ">=": [{ var: "amount" }, ATO_HIGH_AMOUNT] },
        { "<=": [{ var: "session_to_txn_seconds" }, 10] },
        { "!=": [{ var: "ip_country" }, { var: "transaction_country" }] },
      ],
    },
  },
  {
    name: "fatf: untrusted device with significant amount",
    description:
      "Untrusted device on a non-trivial amount. Default threshold tuned for Nigerian retail; raise for higher-value markets.",
    stage: RuleStage.POST,
    priority: 140,
    action: RuleAction.REVIEW,
    expression: {
      and: [
        { "==": [{ var: "device_is_trusted" }, false] },
        { ">=": [{ var: "amount" }, UNTRUSTED_DEVICE_AMOUNT] },
      ],
    },
  },
];

export async function seed(knex: Knex): Promise<void> {
  for (const rule of FATF_RULES) {
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
      createdBy: "fatf-pack-seed",
    });
  }
}
