import { errorCodes, findByCode, validateFixture, warningCodes } from "./helpers";

const PROD = { NODE_ENV: "production" };

describe("PAA is a singleton", () => {
  it("rejects more than one replica", () => {
    const { findings, ok } = validateFixture("paa-scaled.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toContain("paa-replicas");
  });

  it("explains what breaks rather than only forbidding it", () => {
    const { findings } = validateFixture("paa-scaled.yaml");
    const finding = findByCode(findings, "paa-replicas");
    expect(finding?.path).toBe("services.paa.replicas");
    expect(finding?.detail).toContain("memory");
    expect(finding?.detail).toContain("paa-service/README.md");
    expect(finding?.detail).toContain("planned, not available");
  });

  it("accepts exactly one", () => {
    const { findings } = validateFixture("default.yaml");
    expect(errorCodes(findings)).toEqual([]);
  });
});

describe("MLA is a singleton", () => {
  it("rejects more than one replica when enabled", () => {
    const { findings, ok } = validateFixture("mla-scaled.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toContain("mla-replicas");
  });

  it("names the reason: no lease, in-process cooldown, shared models mount", () => {
    const { findings } = validateFixture("mla-scaled.yaml");
    const detail = findByCode(findings, "mla-replicas")?.detail ?? "";
    expect(detail).toContain("cooldown");
    expect(detail).toContain("leader lease");
    expect(detail).toContain("models/");
  });

  it("ignores the replica count while MLA is switched off", () => {
    const { findings, ok } = validateFixture("mla-scaled-disabled.yaml");
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
  });
});

describe("FIA scale-out", () => {
  it("is allowed, with a warning about memory", () => {
    const { findings, ok } = validateFixture("fia-scaled.yaml");
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
    expect(warningCodes(findings)).toContain("fia-replicas");
  });

  it("mentions the shared weights cache and the dropped host port", () => {
    const { findings } = validateFixture("fia-scaled.yaml");
    const detail = findByCode(findings, "fia-replicas")?.detail ?? "";
    expect(detail).toContain("16 GiB");
    expect(detail).toContain("downloaded once");
    expect(detail).toContain("9094");
  });

  it("says nothing when FIA runs a single replica", () => {
    const { findings } = validateFixture("default.yaml");
    expect(warningCodes(findings)).not.toContain("fia-replicas");
  });
});

describe("FIA footprint", () => {
  it("warns as soon as FIA is enabled", () => {
    const { findings, ok } = validateFixture("fia-scaled.yaml");
    expect(ok).toBe(true);
    const finding = findByCode(findings, "fia-enabled");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("10 GB");
    expect(finding?.message).toContain("16 GB");
  });

  it("points at both ways to avoid the download", () => {
    const { findings } = validateFixture("fia-scaled.yaml");
    const detail = findByCode(findings, "fia-enabled")?.detail ?? "";
    expect(detail).toContain("FIA_LLM_MODEL_PATH");
    expect(detail).toContain("FIA_DISABLE_LLM");
  });

  it("stays quiet while FIA is off", () => {
    const { findings } = validateFixture("default.yaml");
    expect(warningCodes(findings)).not.toContain("fia-enabled");
  });
});

describe("open predict endpoint", () => {
  it("warns when no API key is required", () => {
    const { findings, ok } = validateFixture("default.yaml");
    expect(ok).toBe(true);
    expect(warningCodes(findings)).toContain("predict-unauthenticated");
  });

  it("says nothing once keys are required", () => {
    const { findings } = validateFixture("hardened.yaml");
    expect(warningCodes(findings)).not.toContain("predict-unauthenticated");
  });

  it("defers to the production rule rather than saying it twice", () => {
    const { findings } = validateFixture("default.yaml", PROD);
    expect(warningCodes(findings)).not.toContain("predict-unauthenticated");
    expect(errorCodes(findings)).toContain("prod-api-key");
  });
});

describe("production defaults", () => {
  it("passes a hardened manifest", () => {
    const { findings, ok } = validateFixture("hardened.yaml", PROD);
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
  });

  it("rejects all three shipped defaults in production", () => {
    const { findings, ok } = validateFixture("default.yaml", PROD);
    expect(ok).toBe(false);
    expect(errorCodes(findings).sort()).toEqual(["prod-api-key", "prod-cors", "prod-jwt-secret"]);
  });

  it("downgrades to warnings outside production", () => {
    const { findings, ok } = validateFixture("default.yaml");
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
    expect(warningCodes(findings)).toEqual(
      expect.arrayContaining(["prod-jwt-secret", "prod-cors"])
    );
  });

  it("honours ALLOW_UNSAFE_PROD_DEFAULTS, as RDA does", () => {
    const { findings, ok } = validateFixture("default.yaml", {
      ...PROD,
      ALLOW_UNSAFE_PROD_DEFAULTS: "true",
    });
    expect(ok).toBe(true);
    expect(warningCodes(findings)).toEqual(
      expect.arrayContaining(["prod-api-key", "prod-cors", "prod-jwt-secret"])
    );
    expect(findByCode(findings, "prod-cors")?.detail).toContain("RDA will boot anyway");
  });

  it("treats any value other than true as not set", () => {
    const { ok } = validateFixture("default.yaml", {
      ...PROD,
      ALLOW_UNSAFE_PROD_DEFAULTS: "yes",
    });
    expect(ok).toBe(false);
  });

  it("catches the shipped development JWT secret", () => {
    const { findings } = validateFixture("default.yaml", {
      ...PROD,
      AUTH_JWT_SECRET: "dev-only-secret-change-in-prod-please-rotate-min-32-chars",
    });
    expect(errorCodes(findings)).toContain("prod-jwt-secret");
  });

  it("catches a secret that is merely too short", () => {
    const { findings } = validateFixture("default.yaml", { ...PROD, AUTH_JWT_SECRET: "short" });
    expect(findByCode(findings, "prod-jwt-secret")?.message).toContain("32 characters");
  });

  it("distinguishes an unset secret from a weak one", () => {
    const { findings } = validateFixture("default.yaml", PROD);
    const message = findByCode(findings, "prod-jwt-secret")?.message ?? "";
    expect(message).toContain("not set");
    expect(message).not.toContain("32 characters");
  });

  it("accepts a 32-character secret", () => {
    const { findings } = validateFixture("default.yaml", {
      ...PROD,
      AUTH_JWT_SECRET: "a".repeat(32),
    });
    expect(errorCodes(findings)).not.toContain("prod-jwt-secret");
  });

  it("rejects a public_url on localhost, since CORS is derived from it", () => {
    const { findings } = validateFixture("default.yaml", PROD);
    expect(findByCode(findings, "prod-cors")?.path).toBe("network.public_url");
  });
});

describe("external datastores", () => {
  it("accepts a literal connection URL", () => {
    const { findings, ok } = validateFixture("external-postgres.yaml");
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
  });

  it("resolves a reference from the environment", () => {
    const { ok } = validateFixture("external-unresolved.yaml", {
      NOWHERE_DB_URL: "postgresql://ojuri@db.internal:5432/fraud_db",
    });
    expect(ok).toBe(true);
  });

  it("rejects a required field whose reference never resolved, naming the variable", () => {
    const { findings, ok } = validateFixture("external-unresolved.yaml");
    expect(ok).toBe(false);
    const finding = findByCode(findings, "unresolved-reference");
    expect(finding?.path).toBe("datastores.postgres.url");
    expect(finding?.message).toContain("NOWHERE_DB_URL");
  });

  it("only warns when an optional field is unresolved", () => {
    const { findings, ok } = validateFixture("external-redis-no-password.yaml");
    expect(ok).toBe(true);
    const finding = findByCode(findings, "unresolved-reference-optional");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("NOWHERE_REDIS_PASSWORD");
  });

  it("ignores connection fields entirely while the datastore is bundled", () => {
    const { findings } = validateFixture("default.yaml");
    expect(errorCodes(findings)).not.toContain("unresolved-reference");
  });
});

describe("Sentinel", () => {
  it("is allowed on its own and does not require a public URL", () => {
    const { findings, ok } = validateFixture("sentinel-no-fia.yaml");
    expect(ok).toBe(true);
    expect(errorCodes(findings)).toEqual([]);
  });

  it("warns that FIA pages will be unavailable when FIA is off", () => {
    const { findings } = validateFixture("sentinel-no-fia.yaml");
    const finding = findByCode(findings, "sentinel-without-fia");
    expect(finding?.severity).toBe("warning");
    expect(finding?.detail).toContain("empty state");
  });

  it("stays quiet when both are enabled", () => {
    const { findings } = validateFixture("fia-scaled.yaml");
    expect(warningCodes(findings)).not.toContain("sentinel-without-fia");
  });
});

describe("defaults", () => {
  it("treats an all-defaults manifest exactly like the committed one", () => {
    const minimal = validateFixture("minimal.yaml");
    const full = validateFixture("default.yaml");
    expect(minimal.ok).toBe(true);
    expect(warningCodes(minimal.findings)).toEqual(warningCodes(full.findings));
    expect(errorCodes(minimal.findings)).toEqual(errorCodes(full.findings));
  });
});
