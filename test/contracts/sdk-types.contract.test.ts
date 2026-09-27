import fs from "fs";
import path from "path";

/**
 * The SDK hand-copies these shapes and nothing at runtime binds the two, so a
 * server-side change would reach adopters as a silent undefined or a wrong
 * type. A type-level check cannot work here: the root tsconfig resolves
 * modules Node10-style and the SDK's sources carry ESM `.js` specifiers, so
 * the import degrades to `any` and passes whatever it is given.
 *
 * Comparing names alone is not enough either — it lets `number` become
 * `string` and required become optional. Each field is reduced to a
 * (optional, nullable, array, kind) tuple so the two sides can be compared
 * without failing on equivalent spellings: the server writes a union of
 * string literals where the SDK writes a template literal over the enum, and
 * both mean the same wire value.
 */
const ROOT = path.join(__dirname, "..", "..");
const SDK = path.join(ROOT, "packages", "sdk", "src");
const DTO = "src/v1/modules/rda/dtos/predict-request.dto.ts";

interface FieldShape {
  optional: boolean;
  nullable: boolean;
  array: boolean;
  kind: string;
}

function read(...segments: string[]): string {
  return fs.readFileSync(path.join(...segments), "utf8");
}

// A named type is either an enum, which is wire-equivalent to a literal union,
// or an interface, which is wire-equivalent to an inline object literal.
// Telling them apart needs the enum names, so collect them from the SDK.
const ENUM_NAMES = new Set(
  fs
    .readdirSync(path.join(SDK, "enums"))
    .flatMap((file) => [...read(SDK, "enums", file).matchAll(/enum (\w+)/g)].map((m) => m[1]))
);

function block(source: string, declaration: string): string {
  const match = source.match(new RegExp(`interface ${declaration}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!match) throw new Error(`Declaration not found: ${declaration}`);
  return match[1];
}

function fields(body: string): Map<string, FieldShape> {
  const shapes = new Map<string, FieldShape>();
  for (const line of body.split("\n")) {
    const match = line.match(/^\s{2}(?:readonly\s+)?([a-zA-Z_][\w]*)(\??)\s*:\s*(.+?);\s*(?:\/\/.*)?$/);
    if (!match) continue;
    shapes.set(match[1], shapeOf(match[3], match[2] === "?"));
  }
  return shapes;
}

function shapeOf(rawType: string, optional: boolean): FieldShape {
  let type = rawType.trim();
  const members = type.split("|").map((m) => m.trim());
  const nullable = members.some((m) => m === "null" || m === "undefined");
  const present = members.filter((m) => m !== "null" && m !== "undefined");
  type = present.join(" | ");

  const array = /\[\]$/.test(type) || /^Array</.test(type);
  if (array) type = type.replace(/\[\]$/, "").replace(/^Array<(.*)>$/, "$1");

  return { optional, nullable, array, kind: kindOf(type) };
}

// Equivalent spellings collapse to one token so the comparison survives the
// server writing a literal union where the SDK writes a template literal.
function kindOf(type: string): string {
  const members = type.split("|").map((m) => m.trim());
  if (members.length > 1 && members.every((m) => /^"[^"]*"$/.test(m))) return "string-enum";
  if (/^`\$\{[\w.]+\}`$/.test(type)) return "string-enum";
  if (/^"[^"]*"$/.test(type)) return "string-enum";
  if (["string", "number", "boolean", "unknown", "never"].includes(type)) return type;
  if (ENUM_NAMES.has(type)) return "string-enum";
  return "object";
}

function describe_(shape: FieldShape): string {
  return `${shape.kind}${shape.array ? "[]" : ""}${shape.nullable ? "|null" : ""}${shape.optional ? " (optional)" : ""}`;
}

function comparable(shapes: Map<string, FieldShape>): Record<string, string> {
  return Object.fromEntries([...shapes].map(([name, shape]) => [name, describe_(shape)]));
}

describe("@ojuri/sdk contract with the server", () => {
  it.each([
    ["PredictRequest", "PredictRequestDto", "types/predict.types.ts"],
    ["PredictResponse", "PredictResponseDto", "types/predict.types.ts"],
    ["ReasonCode", "ReasonCodeDto", "types/predict.types.ts"],
    ["DeviceFingerprint", "DeviceFingerprint", "types/predict.types.ts"],
  ])("%s matches %s field for field, including types", (sdkName, serverName, sdkPath) => {
    const server = comparable(fields(block(read(ROOT, DTO), serverName)));
    const sdk = comparable(fields(block(read(SDK, sdkPath), sdkName)));

    expect(sdk).toEqual(server);
  });

  // `rule` is an inline object literal on the server and a named interface in
  // the SDK, so the field-level comparison above can only see "object". Its
  // members are exactly the drift class that shipped wrong once.
  it("PredictRuleHit matches the inline rule literal on the response DTO", () => {
    const literal = read(ROOT, DTO).match(/rule\?:\s*\{([^}]*)\}/);
    if (!literal) throw new Error("Inline rule literal not found on PredictResponseDto");

    const server = Object.fromEntries(
      literal[1]
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, type] = part.split(/:(.*)/s);
          return [name.replace("?", "").trim(), describe_(shapeOf(type, name.includes("?")))];
        })
    );
    const sdk = comparable(fields(block(read(SDK, "types/predict.types.ts"), "PredictRuleHit")));

    expect(sdk).toEqual(server);
  });

  it.each([
    ["Decision", "src/shared/enums/decision.enum.ts", "enums/decision.enum.ts"],
    ["DecisionSource", "src/shared/enums/decision-source.enum.ts", "enums/decision-source.enum.ts"],
    ["RuleStage", "src/shared/enums/rule-stage.enum.ts", "enums/rule-stage.enum.ts"],
    ["WebhookEvent", "src/shared/enums/webhook-event.enum.ts", "enums/webhook-event.enum.ts"],
    ["ReasonBasis", "src/shared/onnx/reason-codes.types.ts", "enums/reason-basis.enum.ts"],
  ])("%s matches the server enum", (name, serverPath, sdkPath) => {
    const members = (source: string): string[] => {
      const body = source.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));
      if (!body) throw new Error(`Enum not found: ${name}`);
      return [...body[1].matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`).sort();
    };

    expect(members(read(SDK, sdkPath))).toEqual(members(read(ROOT, serverPath)));
  });

  it("guards against an index signature hiding future drift", () => {
    expect(read(SDK, "types/predict.types.ts")).not.toMatch(/\[key:\s*string\]/);
  });
});
