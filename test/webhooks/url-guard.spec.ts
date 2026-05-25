import { isWebhookUrlSafe } from "../../src/shared/webhooks/url-guard";

// Save/restore env so tests don't pollute each other.
const ORIGINAL_ALLOW_HTTP = process.env.WEBHOOK_ALLOW_HTTP;
const ORIGINAL_ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
beforeEach(() => {
  process.env.WEBHOOK_ALLOW_HTTP = "false";
  process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "false";
});
afterAll(() => {
  process.env.WEBHOOK_ALLOW_HTTP = ORIGINAL_ALLOW_HTTP;
  process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = ORIGINAL_ALLOW_PRIVATE;
});

describe("isWebhookUrlSafe (URL parsing)", () => {
  it("rejects garbage", async () => {
    await expect(isWebhookUrlSafe("not a url")).resolves.toMatchObject({ ok: false });
  });

  it("rejects unsupported schemes (file, gopher)", async () => {
    await expect(isWebhookUrlSafe("file:///etc/passwd")).resolves.toMatchObject({ ok: false });
    await expect(isWebhookUrlSafe("gopher://example.com/")).resolves.toMatchObject({ ok: false });
  });

  it("rejects http unless WEBHOOK_ALLOW_HTTP is true", async () => {
    await expect(isWebhookUrlSafe("http://example.com/hook")).resolves.toMatchObject({
      ok: false,
    });
  });

  it("rejects URLs with embedded credentials", async () => {
    await expect(
      isWebhookUrlSafe("https://alice:secret@example.com/hook")
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("credentials") });
  });
});

describe("isWebhookUrlSafe (SSRF — IP-literal hostnames)", () => {
  it("rejects 169.254.169.254 (AWS / GCP metadata)", async () => {
    const r = await isWebhookUrlSafe("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("private");
  });

  it("rejects loopback (127.x.x.x)", async () => {
    await expect(isWebhookUrlSafe("https://127.0.0.1/")).resolves.toMatchObject({ ok: false });
    await expect(isWebhookUrlSafe("https://127.5.5.5/")).resolves.toMatchObject({ ok: false });
  });

  it("rejects every RFC1918 range", async () => {
    for (const addr of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      const r = await isWebhookUrlSafe(`https://${addr}/`);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects IPv6 loopback and link-local", async () => {
    for (const literal of ["[::1]", "[fe80::1]", "[fc00::1]"]) {
      const r = await isWebhookUrlSafe(`https://${literal}/`);
      expect(r.ok).toBe(false);
    }
  });

  it("accepts a public IP literal", async () => {
    const r = await isWebhookUrlSafe("https://1.1.1.1/");
    expect(r.ok).toBe(true);
    expect(r.resolvedAddress).toBe("1.1.1.1");
  });
});

describe("isWebhookUrlSafe (env opt-ins)", () => {
  it("WEBHOOK_ALLOW_HTTP=true lets http URLs through (still SSRF-checked)", async () => {
    process.env.WEBHOOK_ALLOW_HTTP = "true";
    const ok = await isWebhookUrlSafe("http://1.1.1.1/");
    expect(ok.ok).toBe(true);
    // SSRF check still applies even when http is allowed:
    const blocked = await isWebhookUrlSafe("http://127.0.0.1/");
    expect(blocked.ok).toBe(false);
  });

  it("WEBHOOK_ALLOW_PRIVATE_NETWORKS=true bypasses the private-range check", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    const r = await isWebhookUrlSafe("https://10.0.0.5/");
    expect(r.ok).toBe(true);
  });
});
