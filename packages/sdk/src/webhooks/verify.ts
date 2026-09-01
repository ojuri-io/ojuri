import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ParsedWebhookSignature, WebhookVerificationInput } from "./verify.types.js";

const DEFAULT_TOLERANCE_SECONDS = 300;

export function parseWebhookSignature(
  header: string | null | undefined
): ParsedWebhookSignature | null {
  if (!header) return null;

  const parts = new Map<string, string>();
  for (const segment of header.split(",")) {
    const [key, value] = segment.trim().split("=", 2);
    if (key && value) parts.set(key, value);
  }

  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1");
  if (!signature || !Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export function verifyWebhookSignature(input: WebhookVerificationInput): boolean {
  const parsed = parseWebhookSignature(input.signatureHeader);
  if (!parsed) return false;

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parsed.timestamp);
  if (skew > tolerance) return false;

  // The server signs with sha256(secret) as the key, not the secret itself.
  const key = createHash("sha256").update(input.secret).digest("hex");
  const expected = createHmac("sha256", key)
    .update(`${parsed.timestamp}.`)
    .update(input.rawBody)
    .digest("hex");

  return timingSafeEqualHex(expected, parsed.signature);
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
