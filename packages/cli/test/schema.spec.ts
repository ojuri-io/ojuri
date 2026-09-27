import { validateAgainstSchema } from "../src/manifest/schema";
import { errorCodes, validateFixture } from "./helpers";

describe("schema", () => {
  it("accepts the default manifest", () => {
    expect(validateAgainstSchema({ version: 1 })).toEqual([]);
  });

  it("requires version", () => {
    const findings = validateAgainstSchema({});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe('Missing required field "version".');
  });

  it("rejects a version other than 1", () => {
    const { findings, ok } = validateFixture("bad-version.yaml");
    expect(ok).toBe(false);
    expect(findings[0]?.path).toBe("version");
    expect(findings[0]?.message).toBe("Must be 1.");
  });

  it("rejects unknown top-level fields", () => {
    const findings = validateAgainstSchema({ version: 1, nonsense: true });
    expect(findings[0]?.message).toBe('Unknown field "nonsense".');
  });

  it("rejects enabled on a required service", () => {
    const { findings, ok } = validateFixture("unknown-field.yaml");
    expect(ok).toBe(false);
    expect(findings[0]?.path).toBe("services.rda");
    expect(findings[0]?.message).toBe('Unknown field "enabled".');
  });

  it("caps replicas at 32", () => {
    const { findings, ok } = validateFixture("bad-replicas.yaml");
    expect(ok).toBe(false);
    expect(findings[0]?.path).toBe("services.rda.replicas");
    expect(findings[0]?.message).toBe("Must be at most 32.");
  });

  it("rejects replicas below 1", () => {
    const findings = validateAgainstSchema({ version: 1, services: { rda: { replicas: 0 } } });
    expect(findings[0]?.message).toBe("Must be at least 1.");
  });

  it("rejects a non-integer replica count", () => {
    const findings = validateAgainstSchema({ version: 1, services: { rda: { replicas: 1.5 } } });
    expect(findings).not.toHaveLength(0);
  });

  it("requires url when postgres is external", () => {
    const findings = validateAgainstSchema({
      version: 1,
      datastores: { postgres: { mode: "external" } },
    });
    expect(findings[0]?.message).toBe('Missing required field "url".');
  });

  it("forbids url when postgres is bundled", () => {
    const { findings, ok } = validateFixture("bundled-with-url.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toEqual(["schema"]);
    expect(findings[0]?.path).toBe("datastores.postgres.url");
  });

  it("requires host when redis is external", () => {
    const findings = validateAgainstSchema({
      version: 1,
      datastores: { redis: { mode: "external" } },
    });
    expect(findings[0]?.message).toBe('Missing required field "host".');
  });

  it("forbids redis connection fields when bundled", () => {
    const findings = validateAgainstSchema({
      version: 1,
      datastores: { redis: { mode: "bundled", host: "cache.internal" } },
    });
    expect(findings[0]?.path).toBe("datastores.redis.host");
  });

  it("requires brokers when kafka is external", () => {
    const findings = validateAgainstSchema({
      version: 1,
      datastores: { kafka: { mode: "external" } },
    });
    expect(findings[0]?.message).toBe('Missing required field "brokers".');
  });

  it("rejects an unknown datastore mode", () => {
    const findings = validateAgainstSchema({
      version: 1,
      datastores: { postgres: { mode: "managed" } },
    });
    expect(findings[0]?.message).toContain('"bundled", "external"');
  });

  it("accepts a pinned and a floating release, and rejects a bare number", () => {
    expect(validateAgainstSchema({ version: 1, release: "v1" })).toEqual([]);
    expect(validateAgainstSchema({ version: 1, release: "v1.6.0" })).toEqual([]);
    expect(validateAgainstSchema({ version: 1, release: "1.6.0" })).not.toHaveLength(0);
  });

  it("accepts optional image and resources overrides", () => {
    expect(
      validateAgainstSchema({
        version: 1,
        services: {
          rda: { replicas: 2, image: "my.registry/rda:custom", resources: { cpu: "2", memory: "4G" } },
        },
      })
    ).toEqual([]);
  });

  it("rejects a memory limit that is not in Compose form", () => {
    const findings = validateAgainstSchema({
      version: 1,
      services: { rda: { resources: { memory: "loads" } } },
    });
    expect(findings[0]?.path).toBe("services.rda.resources.memory");
  });

  it("rejects replicas on sentinel, which has no host port to scale", () => {
    const findings = validateAgainstSchema({
      version: 1,
      services: { sentinel: { enabled: true, replicas: 2 } },
    });
    expect(findings[0]?.message).toBe('Unknown field "replicas".');
  });

  it("requires public_url to look like a URL", () => {
    const findings = validateAgainstSchema({ version: 1, network: { public_url: "sentinel.example.com" } });
    expect(findings[0]?.path).toBe("network.public_url");
  });

  it("rejects an out-of-range http_port", () => {
    expect(validateAgainstSchema({ version: 1, network: { http_port: 0 } })).not.toHaveLength(0);
    expect(validateAgainstSchema({ version: 1, network: { http_port: 70000 } })).not.toHaveLength(0);
  });
});

describe("malformed files", () => {
  it("reports a missing manifest", () => {
    const { findings, ok } = validateFixture("does-not-exist.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toEqual(["missing-manifest"]);
  });

  it("reports an empty manifest", () => {
    const { findings, ok } = validateFixture("empty.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toEqual(["empty-manifest"]);
  });

  it("reports unparseable YAML", () => {
    const { findings, ok } = validateFixture("broken.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toEqual(["unparseable-manifest"]);
  });

  it("reports a top-level sequence", () => {
    const { findings, ok } = validateFixture("not-a-mapping.yaml");
    expect(ok).toBe(false);
    expect(errorCodes(findings)).toEqual(["unparseable-manifest"]);
  });

  it("does not run the semantic rules once the schema has failed", () => {
    // bad-replicas would otherwise also trip the unauthenticated-predict
    // warning; suppressing it keeps the first error visible.
    const { findings } = validateFixture("bad-replicas.yaml");
    expect(errorCodes(findings)).toEqual(["schema"]);
    expect(findings).toHaveLength(1);
  });
});
