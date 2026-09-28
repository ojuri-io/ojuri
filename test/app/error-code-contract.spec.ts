import "reflect-metadata";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode } from "@shared/enums/error-code.enum";

const ERROR_DIR = join(__dirname, "..", "..", "src", "shared", "error");

/**
 * Every AppError subclass has to name a distinct code, because the status alone
 * does not say what a caller should do: three conditions return 409 and four
 * return 503. A new error class defaulting to GENERAL_ERROR puts a client back
 * to matching on message text.
 */
describe("error codes", () => {
  const files = readdirSync(ERROR_DIR).filter(
    (f) => f.endsWith(".error.ts") && f !== "app.error.ts"
  );

  it.each(files)("%s names a code", (file) => {
    expect(readFileSync(join(ERROR_DIR, file), "utf8")).toMatch(/this\.errorCode = ErrorCode\./);
  });

  it("gives each class its own code, so none of them collide", () => {
    const used = files.map((file) => {
      const m = readFileSync(join(ERROR_DIR, file), "utf8").match(/ErrorCode\.([A-Z_]+)/);
      return m ? m[1] : "<none>";
    });

    expect(new Set(used).size).toBe(used.length);
  });

  it("uses no code that is absent from the enum", () => {
    const declared = new Set(Object.keys(ErrorCode));
    for (const file of files) {
      const m = readFileSync(join(ERROR_DIR, file), "utf8").match(/ErrorCode\.([A-Z_]+)/);
      if (m) expect(declared).toContain(m[1]);
    }
  });

  it("serialises every code in snake_case, since they appear on the wire", () => {
    for (const value of Object.values(ErrorCode)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
