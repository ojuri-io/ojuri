import { evaluate } from "../../src/shared/rules/evaluator";
import { RuleContext, RuleExpression } from "../../src/shared/rules/rule.types";
import { TransactionType } from "../../src/shared/enums/transaction-type.enum";
import { FATF_RULES } from "../../src/database/seeds/03_fatf_rule_pack";

const baseCtx: RuleContext = {
  transaction_id: "t",
  sender_id: "s",
  receiver_id: "r",
  amount: 0,
  transaction_type: TransactionType.PAYMENT,
  timestamp: 0,
};

function ruleExpr(nameFragment: string): RuleExpression {
  const found = FATF_RULES.find((r) => r.name.includes(nameFragment));
  if (!found) throw new Error(`rule not found: ${nameFragment}`);
  return found.expression;
}

describe("FATF rule pack", () => {
  it("structuring rule fires for CASH_OUT just under the NFIU ₦5M CTR threshold", () => {
    const expr = ruleExpr("structuring");
    expect(evaluate(expr, { ...baseCtx, transaction_type: TransactionType.CASH_OUT, amount: 4_800_000 })).toBe(true);
    expect(evaluate(expr, { ...baseCtx, transaction_type: TransactionType.CASH_OUT, amount: 4_000_000 })).toBe(false);
    expect(evaluate(expr, { ...baseCtx, transaction_type: TransactionType.CASH_OUT, amount: 5_500_000 })).toBe(false);
    expect(evaluate(expr, { ...baseCtx, transaction_type: TransactionType.TRANSFER, amount: 4_800_000 })).toBe(false);
  });

  it("VPN + significant-amount rule fires when both conditions hold", () => {
    const expr = ruleExpr("VPN");
    expect(evaluate(expr, { ...baseCtx, ip_is_vpn: true, amount: 200_000 })).toBe(true);
    expect(evaluate(expr, { ...baseCtx, ip_is_vpn: false, amount: 200_000 })).toBe(false);
    expect(evaluate(expr, { ...baseCtx, ip_is_vpn: true, amount: 50_000 })).toBe(false);
  });

  it("high-risk corridor rule fires on TRANSFER to FATF list", () => {
    const expr = ruleExpr("high-risk corridor");
    expect(
      evaluate(expr, { ...baseCtx, transaction_type: TransactionType.TRANSFER, destination_country: "KP" }),
    ).toBe(true);
    expect(
      evaluate(expr, { ...baseCtx, transaction_type: TransactionType.TRANSFER, destination_country: "NG" }),
    ).toBe(false);
    expect(
      evaluate(expr, { ...baseCtx, transaction_type: TransactionType.PAYMENT, destination_country: "KP" }),
    ).toBe(false);
  });

  it("ATO signature rule fires on rushed-session geography mismatch", () => {
    const expr = ruleExpr("account-takeover");
    expect(
      evaluate(expr, {
        ...baseCtx,
        amount: 2_000_000,
        session_to_txn_seconds: 3,
        ip_country: "RU",
        transaction_country: "NG",
      }),
    ).toBe(true);
    expect(
      evaluate(expr, {
        ...baseCtx,
        amount: 2_000_000,
        session_to_txn_seconds: 3,
        ip_country: "NG",
        transaction_country: "NG",
      }),
    ).toBe(false);
    expect(
      evaluate(expr, {
        ...baseCtx,
        amount: 100,
        session_to_txn_seconds: 3,
        ip_country: "RU",
        transaction_country: "NG",
      }),
    ).toBe(false);
  });

  it("untrusted-device rule fires on POST stage", () => {
    const expr = ruleExpr("untrusted device");
    expect(evaluate(expr, { ...baseCtx, device_is_trusted: false, amount: 300_000 })).toBe(true);
    expect(evaluate(expr, { ...baseCtx, device_is_trusted: true, amount: 300_000 })).toBe(false);
    expect(evaluate(expr, { ...baseCtx, device_is_trusted: false, amount: 50_000 })).toBe(false);
  });
});
