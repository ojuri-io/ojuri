import fs from "fs";
import path from "path";

/**
 * The SDK hand-copies these shapes and nothing at runtime binds the two, so a
 * server-side rename would reach adopters as a silent `undefined` — that is
 * how six DecisionAuditRow field names shipped wrong once. A type-level check
 * cannot work here: the root tsconfig resolves modules Node10-style and the
 * SDK's sources carry ESM `.js` specifiers, so the import degrades to `any`
 * and passes whatever it is given. Comparing the declarations as text does
 * fail, in both directions.
 */
const ROOT = path.join(__dirname, "..", "..");
const SDK = path.join(ROOT, "packages", "sdk", "src");

function read(...segments: string[]): string {
  return fs.readFileSync(path.join(...segments), "utf8");
}

function fieldNames(source: string, blockPattern: RegExp): Set<string> {
  const block = source.match(blockPattern);
  if (!block) throw new Error(`Declaration block not found: ${blockPattern}`);
  const names = [...block[1].matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z_][\w]*)[!?]?\s*:/gm)];
  return new Set(names.map((m) => m[1]));
}

function enumMembers(source: string, name: string): string[] {
  const block = source.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!block) throw new Error(`Enum not found: ${name}`);
  return [...block[1].matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
}

describe("@ojuri/sdk contract with the server", () => {
  it("DecisionAuditRow declares exactly the audit model's fields", () => {
    const server = fieldNames(
      read(ROOT, "src/shared/audit/model/decision-audit.model.ts"),
      /class DecisionAudit[\s\S]*?\{([\s\S]*?)\n\}/m
    );
    const sdk = fieldNames(
      read(SDK, "types/decision.types.ts"),
      /interface DecisionAuditRow\s*\{([\s\S]*?)\n\}/m
    );

    server.delete("tableName");
    server.delete("idColumn");
    server.delete("jsonSchema");

    expect([...sdk].sort()).toEqual([...server].sort());
  });

  it("ReasonCode declares exactly the explainer's fields", () => {
    const server = fieldNames(
      read(ROOT, "src/shared/onnx/reason-codes.types.ts"),
      /interface ReasonCode\s*\{([\s\S]*?)\n\}/m
    );
    const sdk = fieldNames(
      read(SDK, "types/predict.types.ts"),
      /interface ReasonCode\s*\{([\s\S]*?)\n\}/m
    );

    expect([...sdk].sort()).toEqual([...server].sort());
  });

  it("PredictRequest declares exactly the predict DTO's fields", () => {
    const server = fieldNames(
      read(ROOT, "src/v1/modules/rda/dtos/predict-request.dto.ts"),
      /interface PredictRequestDto\s*\{([\s\S]*?)\n\}/m
    );
    const sdk = fieldNames(
      read(SDK, "types/predict.types.ts"),
      /interface PredictRequest\s*\{([\s\S]*?)\n\}/m
    );

    expect([...sdk].sort()).toEqual([...server].sort());
  });

  it.each([
    ["Decision", "src/shared/enums/decision.enum.ts", "enums/decision.enum.ts"],
    ["DecisionSource", "src/shared/enums/decision-source.enum.ts", "enums/decision-source.enum.ts"],
    ["RuleStage", "src/shared/enums/rule-stage.enum.ts", "enums/rule-stage.enum.ts"],
    ["RuleAction", "src/shared/enums/rule-action.enum.ts", "enums/rule-action.enum.ts"],
    ["WebhookEvent", "src/shared/enums/webhook-event.enum.ts", "enums/webhook-event.enum.ts"],
    ["ReasonBasis", "src/shared/onnx/reason-codes.types.ts", "enums/reason-basis.enum.ts"],
  ])("%s matches the server enum", (name, serverPath, sdkPath) => {
    expect(enumMembers(read(SDK, sdkPath), name)).toEqual(
      enumMembers(read(ROOT, serverPath), name)
    );
  });

  it("guards against an index signature hiding future drift", () => {
    const types = read(SDK, "types/decision.types.ts") + read(SDK, "types/report.types.ts");
    expect(types).not.toMatch(/\[key:\s*string\]/);
  });
});
