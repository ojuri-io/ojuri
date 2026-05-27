import { createHash, createHmac } from "crypto";

// Round-trip test of the webhook HMAC scheme documented in
// docs/WEBHOOKS.md. We don't import WebhookService here because that
// pulls in DB / repo wiring; the signing scheme is small enough to
// re-implement and assert against, which is also what subscribers
// must do to verify deliveries on their end.

const SECRET = "whsec_test_dont_use_in_prod_32chars_min";

function sign(timestamp: string, body: string): string {
  // Server-side signs with sha256(secret) — the storage scheme.
  const secretHash = createHash("sha256").update(SECRET).digest("hex");
  return createHmac("sha256", secretHash).update(`${timestamp}.${body}`).digest("hex");
}

function clientVerify(headerValue: string, body: string, maxAgeSec = 300): boolean {
  // Parse `t=<unix>,v1=<hex>` per docs/WEBHOOKS.md.
  const parts = headerValue.split(",").reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split("=", 2);
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;

  const ts = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(ts)) return false;

  // Reject anything older than maxAgeSec — defends against replays of
  // a captured delivery long after the fact.
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > maxAgeSec) return false;

  // Client must repeat the hash-of-secret step. We give the test
  // subscriber the raw secret (what they received at registration).
  const secretHash = createHash("sha256").update(SECRET).digest("hex");
  const expected = createHmac("sha256", secretHash).update(`${parts.t}.${body}`).digest("hex");

  if (expected.length !== parts.v1.length) return false;
  // Constant-time compare — docs sample uses crypto.timingSafeEqual.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  }
  return diff === 0;
}

describe("webhook HMAC scheme", () => {
  const body = JSON.stringify({
    event: "decision.created",
    data: { audit_id: "abc", decision: "DECLINE" },
    sent_at: "2026-05-26T00:00:00.000Z",
  });

  it("a freshly signed delivery verifies", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const v1 = sign(ts, body);
    expect(clientVerify(`t=${ts},v1=${v1}`, body)).toBe(true);
  });

  it("body tampering invalidates the signature", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const v1 = sign(ts, body);
    const tamperedBody = body.replace("DECLINE", "ACCEPT");
    expect(clientVerify(`t=${ts},v1=${v1}`, tamperedBody)).toBe(false);
  });

  it("signature mutation invalidates", () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const v1 = sign(ts, body);
    // flip the last hex char
    const mutated = v1.slice(0, -1) + (v1.endsWith("0") ? "1" : "0");
    expect(clientVerify(`t=${ts},v1=${mutated}`, body)).toBe(false);
  });

  it("rejects replays older than the configured window", () => {
    const tenMinutesAgo = (Math.floor(Date.now() / 1000) - 600).toString();
    const v1 = sign(tenMinutesAgo, body);
    expect(clientVerify(`t=${tenMinutesAgo},v1=${v1}`, body, 300)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(clientVerify("garbage", body)).toBe(false);
    expect(clientVerify("t=,v1=", body)).toBe(false);
    expect(clientVerify("v1=deadbeef", body)).toBe(false); // no `t`
  });
});
