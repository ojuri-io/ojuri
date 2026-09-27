import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * There is no nginx binary in CI to run `nginx -t` against, so this is a
 * structural check rather than a parse. The compose healthcheck for the
 * nginx service is `nginx -t`, so a genuine syntax error would surface
 * the first time the sentinel profile is started.
 */
const REPO = join(__dirname, "..", "..", "..");
const DEFAULT_CONF = readFileSync(join(REPO, "nginx", "nginx.conf"), "utf8");
const SENTINEL_CONF = readFileSync(join(REPO, "nginx", "nginx.sentinel.conf"), "utf8");

function braceBalance(text: string): number {
  // Comments can hold stray braces; strip them before counting.
  const code = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth < 0) return -1;
  }
  return depth;
}

describe("nginx.sentinel.conf", () => {
  it("has balanced braces", () => {
    expect(braceBalance(SENTINEL_CONF)).toBe(0);
    expect(braceBalance(DEFAULT_CONF)).toBe(0);
  });

  it("routes / to the sentinel container", () => {
    expect(SENTINEL_CONF).toContain("set $sentinel_upstream sentinel;");
    expect(SENTINEL_CONF).toContain("proxy_pass http://$sentinel_upstream:80;");
  });

  it("resolves the sentinel hostname per request so nginx starts without it", () => {
    // A literal upstream would make nginx hard-fail at startup whenever
    // the sentinel container is absent, exactly as it used to for FIA.
    expect(SENTINEL_CONF).toContain("resolver 127.0.0.11");
    expect(SENTINEL_CONF).not.toMatch(/proxy_pass\s+http:\/\/sentinel:80/);
  });

  it("gives the API its own /v1/ prefix, since / no longer reaches RDA", () => {
    expect(DEFAULT_CONF).not.toContain("location /v1/ {");
    expect(SENTINEL_CONF).toContain("location /v1/ {");
  });

  it("keeps the load-balanced RDA upstream rather than a single resolved address", () => {
    expect(SENTINEL_CONF).toContain("upstream rda_backend");
    expect(SENTINEL_CONF).toContain("least_conn;");
    expect(SENTINEL_CONF).toContain("server rda:3000");
  });

  it("keeps every route the default config serves", () => {
    for (const location of [
      "location = /health {",
      "location = /ready {",
      "location /v1/predict {",
      "location /v1/metrics {",
      "location /v1/admin/training/upload {",
      "location /mla/ {",
      "location /fia/ {",
      "location /nginx_status {",
    ]) {
      expect(DEFAULT_CONF).toContain(location);
      expect(SENTINEL_CONF).toContain(location);
    }
  });

  it("keeps the predict rate limit, so the two configs behave the same under load", () => {
    expect(SENTINEL_CONF).toContain("limit_req_zone");
    expect(SENTINEL_CONF).toContain("limit_req zone=api_limit burst=50 nodelay;");
  });

  it("differs from the default config only in the documented ways", () => {
    // Everything up to the routing change should be byte-identical, so a
    // fix to one file is obvious in a diff of the other.
    const marker = "        # Metrics endpoint";
    const defaultHead = DEFAULT_CONF.slice(DEFAULT_CONF.indexOf("http {"), DEFAULT_CONF.indexOf(marker));
    const sentinelHead = SENTINEL_CONF.slice(
      SENTINEL_CONF.indexOf("http {"),
      SENTINEL_CONF.indexOf(marker)
    );
    expect(sentinelHead).toBe(defaultHead);
  });

  it("says which file it is and why, at the top", () => {
    expect(SENTINEL_CONF.startsWith("# Sentinel variant of nginx.conf.")).toBe(true);
    expect(SENTINEL_CONF).toContain("Do not edit one of these two files without checking the other.");
  });
});
