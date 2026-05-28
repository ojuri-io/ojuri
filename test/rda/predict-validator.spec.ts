import "reflect-metadata";
import Validator from "validatorjs";
import {
  predictValidationRules,
  predictValidationMessages,
} from "../../src/v1/modules/rda/validations/predict.validator";

// The validator rules reference `uuid`, a custom rule registered in
// src/bootstrap.ts at runtime. Bootstrap isn't called in this test
// (it pulls in DB + Fastify), so register the rule directly. Must
// match the regex in bootstrap.ts.
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
Validator.register("uuid", (value: unknown) => typeof value === "string" && uuidRegex.test(value),
  ":attribute is not a valid UUID");

function check(body: Record<string, unknown>) {
  const v = new Validator(body, predictValidationRules, predictValidationMessages);
  return { valid: v.passes(), errors: v.errors.all() };
}

const baseValid = {
  transaction_id: "550e8400-e29b-41d4-a716-446655440000",
  sender_id: "u1",
  receiver_id: "u2",
  amount: 1500.0,
  transaction_type: "TRANSFER",
  timestamp: 1717718400000,
};

describe("predict.validator — happy path", () => {
  it("accepts the README example", () => {
    const result = check(baseValid);
    expect(result.valid).toBe(true);
  });

  it("accepts amount at the lower bound (0.01)", () => {
    expect(check({ ...baseValid, amount: 0.01 }).valid).toBe(true);
  });

  it("accepts amount at the upper bound (9_999_999_999)", () => {
    expect(check({ ...baseValid, amount: 9999999999 }).valid).toBe(true);
  });

  it("accepts timestamp at the upper bound (~year 2286)", () => {
    expect(check({ ...baseValid, timestamp: 9999999999999 }).valid).toBe(true);
  });
});

describe("predict.validator — required-field rejections", () => {
  it("rejects missing transaction_id", () => {
    const { valid, errors } = check({ ...baseValid, transaction_id: undefined });
    expect(valid).toBe(false);
    expect(errors).toHaveProperty("transaction_id");
  });

  it("rejects transaction_id shorter than the 10-char floor", () => {
    const { valid, errors } = check({ ...baseValid, transaction_id: "short" });
    expect(valid).toBe(false);
    expect(errors).toHaveProperty("transaction_id");
  });

  it("accepts any 10+ char string (no UUID requirement)", () => {
    const { valid } = check({ ...baseValid, transaction_id: "PSP-2026-001-ABCDEF" });
    expect(valid).toBe(true);
  });

  it("rejects missing required scalars", () => {
    for (const f of ["sender_id", "receiver_id", "amount", "transaction_type", "timestamp"]) {
      const { valid, errors } = check({ ...baseValid, [f]: undefined });
      expect(valid).toBe(false);
      expect(errors).toHaveProperty(f);
    }
  });
});

describe("predict.validator — bound rejections (regression for the security audit)", () => {
  it("rejects negative amount", () => {
    expect(check({ ...baseValid, amount: -1 }).valid).toBe(false);
  });

  it("rejects amount below the 0.01 minimum", () => {
    expect(check({ ...baseValid, amount: 0 }).valid).toBe(false);
  });

  it("rejects unrealistically large amount", () => {
    const { valid, errors } = check({ ...baseValid, amount: 9999999999999999 });
    expect(valid).toBe(false);
    expect(errors).toHaveProperty("amount");
  });

  it("rejects timestamp above the year-2286 cap", () => {
    expect(check({ ...baseValid, timestamp: 9.9e15 }).valid).toBe(false);
  });

  it("rejects non-numeric amount", () => {
    expect(check({ ...baseValid, amount: "not-a-number" }).valid).toBe(false);
  });

  it("rejects transaction_type outside the enum", () => {
    expect(check({ ...baseValid, transaction_type: "WIRE_TRANSFER" }).valid).toBe(false);
  });
});

describe("predict.validator — optional field formats", () => {
  it("rejects out-of-range customer latitude", () => {
    expect(check({ ...baseValid, customer_latitude: 91 }).valid).toBe(false);
    expect(check({ ...baseValid, customer_latitude: -91 }).valid).toBe(false);
    expect(check({ ...baseValid, customer_latitude: 0 }).valid).toBe(true);
  });

  it("rejects unknown customer_type", () => {
    expect(check({ ...baseValid, customer_type: "PARTNERSHIP" }).valid).toBe(false);
    expect(check({ ...baseValid, customer_type: "INDIVIDUAL" }).valid).toBe(true);
  });
});
