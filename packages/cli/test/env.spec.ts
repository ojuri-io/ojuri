import { parseDotenv, resolveReferences, hasUnresolvedReference, lookup } from "../src/manifest/env";

describe("parseDotenv", () => {
  it("reads plain assignments and ignores comments and blanks", () => {
    const env = parseDotenv(["# a comment", "", "FOO=bar", "  BAZ=qux  "].join("\n"));
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching quotes but keeps the inner text", () => {
    const env = parseDotenv(['A="one two"', "B='three'", "C=four five"].join("\n"));
    expect(env).toEqual({ A: "one two", B: "three", C: "four five" });
  });

  it("keeps a bare # inside a value but drops a trailing comment", () => {
    const env = parseDotenv(["A=pa#ss", "B=80 # the default"].join("\n"));
    expect(env).toEqual({ A: "pa#ss", B: "80" });
  });

  it("accepts the export prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("skips lines that are not assignments", () => {
    expect(parseDotenv(["nonsense", "=novalue", "1BAD=x"].join("\n"))).toEqual({});
  });

  it("preserves an empty value", () => {
    expect(parseDotenv("REDIS_PASSWORD=")).toEqual({ REDIS_PASSWORD: "" });
  });

  it("parses the values .env.example actually uses", () => {
    const env = parseDotenv(
      [
        "AUTH_JWT_SECRET=dev-only-secret-change-in-prod-please-rotate-min-32-chars",
        "SENTINEL_CORS_ORIGINS=http://localhost:5173,http://localhost:3000",
        "DB_URL=postgresql://postgres:postgres@localhost:5433/fraud_db",
      ].join("\n")
    );
    expect(env.AUTH_JWT_SECRET).toBe("dev-only-secret-change-in-prod-please-rotate-min-32-chars");
    expect(env.SENTINEL_CORS_ORIGINS).toBe("http://localhost:5173,http://localhost:3000");
    expect(env.DB_URL).toBe("postgresql://postgres:postgres@localhost:5433/fraud_db");
  });
});

describe("lookup", () => {
  const env = { dotenv: { A: "from-file", B: "file-only" }, process: { A: "from-process" } };

  it("prefers the process environment, as Compose does", () => {
    expect(lookup(env, "A")).toBe("from-process");
  });

  it("falls back to .env", () => {
    expect(lookup(env, "B")).toBe("file-only");
  });

  it("returns undefined when neither has it", () => {
    expect(lookup(env, "C")).toBeUndefined();
  });

  it("treats an empty process value as unset so .env still wins", () => {
    expect(lookup({ dotenv: { A: "from-file" }, process: { A: "" } }, "A")).toBe("from-file");
  });
});

describe("resolveReferences", () => {
  const env = { dotenv: { SECRET: "s3cret" }, process: { HOST: "db.internal" } };

  it("substitutes references anywhere in the tree", () => {
    const { value, unresolved } = resolveReferences(
      { auth: { jwt_secret: "${SECRET}" }, list: ["${HOST}"] },
      env
    );
    expect(value).toEqual({ auth: { jwt_secret: "s3cret" }, list: ["db.internal"] });
    expect(unresolved).toEqual([]);
  });

  it("substitutes a reference embedded in a longer string", () => {
    const { value } = resolveReferences({ url: "postgresql://${HOST}:5432/db" }, env);
    expect(value).toEqual({ url: "postgresql://db.internal:5432/db" });
  });

  it("leaves an unresolved reference in place and reports its path", () => {
    const { value, unresolved } = resolveReferences(
      { datastores: { postgres: { url: "${MISSING}" } } },
      env
    );
    expect(value).toEqual({ datastores: { postgres: { url: "${MISSING}" } } });
    expect(unresolved).toEqual([{ path: "datastores.postgres.url", name: "MISSING" }]);
  });

  it("reports every unresolved reference in one string", () => {
    const { unresolved } = resolveReferences({ a: "${ONE}/${TWO}" }, env);
    expect(unresolved.map((u) => u.name)).toEqual(["ONE", "TWO"]);
  });

  it("leaves non-strings alone", () => {
    const { value } = resolveReferences({ n: 3, b: true, nil: null }, env);
    expect(value).toEqual({ n: 3, b: true, nil: null });
  });
});

describe("hasUnresolvedReference", () => {
  it("is stateless across calls", () => {
    // The underlying regex is global; a shared lastIndex would make the
    // second call disagree with the first.
    expect(hasUnresolvedReference("${A}")).toBe(true);
    expect(hasUnresolvedReference("${A}")).toBe(true);
  });

  it("is false for a resolved value and for undefined", () => {
    expect(hasUnresolvedReference("plain")).toBe(false);
    expect(hasUnresolvedReference(undefined)).toBe(false);
  });
});
