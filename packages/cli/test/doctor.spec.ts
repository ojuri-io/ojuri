import {
  compareVersions,
  doctor,
  firstVersion,
  MIN_COMPOSE,
  MIN_DOCKER,
  requiredPorts,
} from "../src/commands/doctor";
import type { Exec, ExecResult } from "../src/exec";
import { effective, type Manifest } from "../src/manifest/types";
import { errorCodes, warningCodes } from "./helpers";

function execWith(responses: Record<string, ExecResult>): Exec {
  return {
    run(argv) {
      const key = argv.join(" ");
      return responses[key] ?? { status: 127, stdout: "", stderr: "not stubbed" };
    },
  };
}

const HEALTHY = execWith({
  "docker --version": { status: 0, stdout: "Docker version 29.3.1, build c2be9cc", stderr: "" },
  "docker compose version": { status: 0, stdout: "Docker Compose version v5.1.1", stderr: "" },
});

const freePorts = async () => null;
const reachable = async () => true;

function cfg(manifest: Manifest = { version: 1 }) {
  return effective(manifest);
}

describe("compareVersions", () => {
  it("compares numerically, so 2.9 is below 2.24", () => {
    // A string comparison would put 2.9 above 2.24 and wave through a
    // Compose too old for the `!reset` the overlay depends on.
    expect(compareVersions("2.9", "2.24")).toBeLessThan(0);
    expect(compareVersions("2.24", "2.24")).toBe(0);
    expect(compareVersions("2.24.1", "2.24")).toBeGreaterThan(0);
    expect(compareVersions("29.3.1", "20.10")).toBeGreaterThan(0);
  });
});

describe("firstVersion", () => {
  it("pulls the version out of the CLI banners", () => {
    expect(firstVersion("Docker version 29.3.1, build c2be9cc")).toBe("29.3.1");
    expect(firstVersion("Docker Compose version v5.1.1")).toBe("5.1.1");
  });

  it("returns null when there is no version", () => {
    expect(firstVersion("command not found")).toBeNull();
  });
});

describe("version checks", () => {
  it("passes a modern Docker and Compose", async () => {
    const findings = await doctor(cfg(), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
    });
    expect(findings).toEqual([]);
  });

  it("reports a missing Docker", async () => {
    const findings = await doctor(cfg(), {
      exec: execWith({}),
      checkPort: freePorts,
      checkTcp: reachable,
    });
    expect(errorCodes(findings)).toContain("docker-missing");
  });

  it("reports a Compose older than the floor, and says why the floor exists", async () => {
    const exec = execWith({
      "docker --version": { status: 0, stdout: "Docker version 24.0.0", stderr: "" },
      "docker compose version": { status: 0, stdout: "Docker Compose version v2.9.0", stderr: "" },
    });
    const findings = await doctor(cfg(), { exec, checkPort: freePorts, checkTcp: reachable });
    expect(errorCodes(findings)).toContain("compose-old");
    expect(findings.find((f) => f.code === "compose-old")?.detail).toContain("!reset");
  });

  it("reports a Docker older than the floor", async () => {
    const exec = execWith({
      "docker --version": { status: 0, stdout: "Docker version 19.03.0", stderr: "" },
      "docker compose version": { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" },
    });
    const findings = await doctor(cfg(), { exec, checkPort: freePorts, checkTcp: reachable });
    expect(errorCodes(findings)).toContain("docker-old");
  });

  it("uses the README's stated minimums", () => {
    expect(MIN_DOCKER).toBe("20.10");
    expect(MIN_COMPOSE).toBe("2.24");
  });
});

describe("required ports", () => {
  it("covers the default stack", () => {
    const ports = requiredPorts(cfg()).map((p) => p.port).sort((a, b) => a - b);
    expect(ports).toEqual([80, 3001, 5433, 6380, 9090, 9091, 9092, 29092]);
  });

  it("drops a datastore's port when it is external", () => {
    const ports = requiredPorts(
      cfg({ version: 1, datastores: { postgres: { mode: "external", url: "postgresql://h/d" } } })
    ).map((p) => p.port);
    expect(ports).not.toContain(5433);
  });

  it("drops Prometheus and Grafana when observability is off", () => {
    const ports = requiredPorts(cfg({ version: 1, observability: { enabled: false } })).map(
      (p) => p.port
    );
    expect(ports).not.toContain(9090);
    expect(ports).not.toContain(3001);
  });

  it("follows http_port rather than assuming 80", () => {
    const ports = requiredPorts(cfg({ version: 1, network: { http_port: 8080 } })).map((p) => p.port);
    expect(ports).toContain(8080);
    expect(ports).not.toContain(80);
  });

  it("does not require FIA's port once it is scaled, since render drops it", () => {
    const single = requiredPorts(cfg({ version: 1, services: { fia: { enabled: true } } }));
    const scaled = requiredPorts(
      cfg({ version: 1, services: { fia: { enabled: true, replicas: 2 } } })
    );
    expect(single.map((p) => p.port)).toContain(9094);
    expect(scaled.map((p) => p.port)).not.toContain(9094);
  });

  it("reports a port that is taken, naming what wanted it", async () => {
    const findings = await doctor(cfg(), {
      exec: HEALTHY,
      checkPort: async (port) => (port === 6380 ? "Something is already listening." : null),
      checkTcp: reachable,
    });
    expect(errorCodes(findings)).toContain("port-taken");
    expect(findings[0]?.message).toContain("Redis");
  });
});

describe("external datastores", () => {
  it("reports one it cannot reach", async () => {
    const findings = await doctor(
      cfg({
        version: 1,
        datastores: { postgres: { mode: "external", url: "postgresql://u@db.internal:6432/d" } },
      }),
      { exec: HEALTHY, checkPort: freePorts, checkTcp: async () => false }
    );
    expect(errorCodes(findings)).toContain("datastore-unreachable");
    expect(findings.find((f) => f.code === "datastore-unreachable")?.message).toContain("6432");
  });

  it("checks only the first Kafka broker", async () => {
    const seen: string[] = [];
    await doctor(
      cfg({
        version: 1,
        datastores: { kafka: { mode: "external", brokers: "b1:9092,b2:9092,b3:9092" } },
      }),
      {
        exec: HEALTHY,
        checkPort: freePorts,
        checkTcp: async (host, port) => {
          seen.push(`${host}:${port}`);
          return true;
        },
      }
    );
    expect(seen).toEqual(["b1:9092"]);
  });

  it("checks nothing when every datastore is bundled", async () => {
    let called = false;
    await doctor(cfg(), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: async () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
  });
});

describe("FIA host requirements", () => {
  const fia: Manifest = { version: 1, services: { fia: { enabled: true } } };

  it("warns when there is not enough RAM", async () => {
    const findings = await doctor(cfg(fia), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
      totalMemoryBytes: () => 8 * 1024 ** 3,
      freeDiskBytes: () => 100 * 1024 ** 3,
    });
    expect(warningCodes(findings)).toContain("fia-ram");
  });

  it("scales the RAM requirement by replica count", async () => {
    const findings = await doctor(
      cfg({ version: 1, services: { fia: { enabled: true, replicas: 3 } } }),
      {
        exec: HEALTHY,
        checkPort: freePorts,
        checkTcp: reachable,
        totalMemoryBytes: () => 32 * 1024 ** 3,
        freeDiskBytes: () => 100 * 1024 ** 3,
      }
    );
    expect(findings.find((f) => f.code === "fia-ram")?.message).toContain("48 GB");
  });

  it("warns when there is not enough disk for the weights", async () => {
    const findings = await doctor(cfg(fia), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
      totalMemoryBytes: () => 64 * 1024 ** 3,
      freeDiskBytes: () => 4 * 1024 ** 3,
    });
    expect(warningCodes(findings)).toContain("fia-disk");
  });

  it("says nothing on a host with room", async () => {
    const findings = await doctor(cfg(fia), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
      totalMemoryBytes: () => 64 * 1024 ** 3,
      freeDiskBytes: () => 100 * 1024 ** 3,
    });
    expect(findings).toEqual([]);
  });

  it("checks nothing about FIA while it is disabled", async () => {
    const findings = await doctor(cfg(), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
      totalMemoryBytes: () => 1 * 1024 ** 3,
      freeDiskBytes: () => 1 * 1024 ** 3,
    });
    expect(findings).toEqual([]);
  });

  it("never errors on a host shortfall, only warns", async () => {
    // The operator may know something we do not, FIA_DISABLE_LLM among
    // them, so a small host is advice rather than a refusal.
    const findings = await doctor(cfg(fia), {
      exec: HEALTHY,
      checkPort: freePorts,
      checkTcp: reachable,
      totalMemoryBytes: () => 1024 ** 3,
      freeDiskBytes: () => 1024 ** 3,
    });
    expect(errorCodes(findings)).toEqual([]);
  });
});
