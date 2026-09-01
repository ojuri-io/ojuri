import { createHash, createHmac } from "node:crypto";
import { parseWebhookSignature, verifyWebhookSignature } from "../webhooks/verify.js";

const SECRET = "whsec_example";
const BODY = JSON.stringify({ event: "decision.created", transaction_id: "txn-1" });

function sign(body: string, timestamp: number, secret = SECRET): string {
  const key = createHash("sha256").update(secret).digest("hex");
  const signature = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("verifyWebhookSignature", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("accepts a signature produced the way the server produces it", () => {
    const header = sign(BODY, now());
    expect(verifyWebhookSignature({ secret: SECRET, signatureHeader: header, rawBody: BODY })).toBe(
      true
    );
  });

  it("accepts a raw Buffer body", () => {
    const header = sign(BODY, now());
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        signatureHeader: header,
        rawBody: Buffer.from(BODY, "utf8"),
      })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = sign(BODY, now());
    expect(
      verifyWebhookSignature({ secret: SECRET, signatureHeader: header, rawBody: `${BODY} ` })
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = sign(BODY, now(), "whsec_other");
    expect(verifyWebhookSignature({ secret: SECRET, signatureHeader: header, rawBody: BODY })).toBe(
      false
    );
  });

  it("rejects a replay outside the tolerance window", () => {
    const header = sign(BODY, now() - 301);
    expect(verifyWebhookSignature({ secret: SECRET, signatureHeader: header, rawBody: BODY })).toBe(
      false
    );
  });

  it("accepts an old delivery when the tolerance is widened", () => {
    const header = sign(BODY, now() - 301);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        signatureHeader: header,
        rawBody: BODY,
        toleranceSeconds: 600,
      })
    ).toBe(true);
  });

  it.each([undefined, null, "", "garbage", "t=abc,v1=def", "v1=deadbeef"])(
    "rejects malformed header %p",
    (header) => {
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          signatureHeader: header as string | null | undefined,
          rawBody: BODY,
        })
      ).toBe(false);
    }
  );

  it("parses a well-formed header", () => {
    expect(parseWebhookSignature("t=1715000000,v1=abcd")).toEqual({
      timestamp: 1715000000,
      signature: "abcd",
    });
  });
});
