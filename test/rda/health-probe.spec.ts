import "reflect-metadata";
import { hostDoesNotResolve, probeError } from "../../src/v1/modules/health/health.service";

/**
 * Both read `error.cause`, which Node populates and the outer message
 * hides: every failed fetch arrives as the same "fetch failed".
 */
async function failedFetch(url: string): Promise<unknown> {
  try {
    await fetch(url);
    throw new Error(`${url} answered, so this spec proves nothing`);
  } catch (err) {
    return err;
  }
}

describe("telling an absent service from a failing one", () => {
  it("reads a hostname with no DNS record as absent", async () => {
    // FIA is off by default, so its container name does not resolve, and
    // a red card for a deliberate absence is a false alarm.
    expect(hostDoesNotResolve(await failedFetch("http://fia.invalid:9094/readyz"))).toBe(true);
  });

  it("reads a refused connection as a failure, not an absence", async () => {
    expect(hostDoesNotResolve(await failedFetch("http://127.0.0.1:59999/readyz"))).toBe(false);
  });

  it("ignores anything that is not an error", () => {
    expect(hostDoesNotResolve("ENOTFOUND")).toBe(false);
    expect(hostDoesNotResolve(undefined)).toBe(false);
  });
});

describe("what the dashboard shows for a failed probe", () => {
  it("surfaces the cause rather than the fetch wrapper", async () => {
    const message = probeError(await failedFetch("http://127.0.0.1:59999/readyz"));
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toBe("fetch failed");
  });

  it("falls back when there is nothing to read", () => {
    expect(probeError("nope")).toBe("probe failed");
    expect(probeError(new Error("plain"))).toBe("plain");
  });
});
