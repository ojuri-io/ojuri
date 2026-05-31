/**
 * Regression test for the Kafka producer lazy-reconnect fix in
 * 39bd177 (§6 Kafka producer reliability).
 *
 * Pre-fix: KafkaProducer cached an `isConnected` boolean from the
 * `producer.connect` / `producer.disconnect` events. kafkajs's
 * `producer.connect` event fires once on startup; under load the
 * underlying socket drops silently with no `disconnect` event, and
 * subsequent `producer.send()` calls reject with "The producer is
 * disconnected". With the gate in place, every retry attempt threw
 * "Kafka producer not connected" before even trying to send, so the
 * disk-buffer accumulated 100k+ failed publishes per session.
 *
 * The fix: drop the self-imposed gate and lazily reconnect inside
 * `publishWithRetry` when the cached flag is false. On a kafkajs
 * "disconnect"-bearing error the cached flag is forced false so the
 * NEXT attempt picks up the reconnect path.
 *
 * Source-level invariants this test pins down:
 *   1. The `if (!this.isConnected) throw new Error("...not connected")`
 *      hard-fail no longer exists in publishWithRetry.
 *   2. A `producer.connect()` call exists inside publishWithRetry as
 *      the lazy-reconnect path.
 *   3. The error handler resets `isConnected = false` on a
 *      disconnect-bearing error message so the retry loop recovers.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const KAFKA_PRODUCER = resolve(
  __dirname,
  "..",
  "..",
  "src",
  "shared",
  "kafka",
  "kafka-producer.ts"
);

describe("KafkaProducer lazy-reconnect", () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(KAFKA_PRODUCER, "utf8");
  });

  it("does not throw 'Kafka producer not connected' from publishWithRetry", () => {
    // The original bug was a literal `throw new Error("Kafka producer
    // not connected")` inside publishWithRetry. Forbid that exact
    // string from coming back via a refactor that mistakenly
    // reintroduces the hard-fail.
    const sendBlockStart = src.indexOf("private async publishWithRetry");
    expect(sendBlockStart).toBeGreaterThan(-1);
    const sendBlock = src.slice(sendBlockStart, sendBlockStart + 3000);
    expect(sendBlock).not.toMatch(/throw new Error\(\s*["']Kafka producer not connected["']/);
  });

  it("attempts producer.connect() inside publishWithRetry as the lazy-reconnect path", () => {
    const sendBlockStart = src.indexOf("private async publishWithRetry");
    const sendBlock = src.slice(sendBlockStart, sendBlockStart + 3000);
    expect(sendBlock).toMatch(/this\.producer\.connect\(\)/);
  });

  it("forces isConnected = false on a 'disconnect'-bearing error so the next retry reconnects", () => {
    const sendBlockStart = src.indexOf("private async publishWithRetry");
    const sendBlock = src.slice(sendBlockStart, sendBlockStart + 3000);
    expect(sendBlock).toMatch(/disconnect/i);
    expect(sendBlock).toMatch(/this\.isConnected\s*=\s*false/);
  });
});
