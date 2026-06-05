/**
 * Synthetic load generator for `POST /v1/predict`.
 *
 * Produces realistic PaySim-style transactions and fires them at a
 * running RDA instance. Useful in demos, capacity planning, and
 * regression testing — combine with `scripts/replay.ts` after a
 * model change to compare distributions.
 *
 * Usage:
 *
 *   ts-node scripts/seed-load.ts \
 *     --url http://localhost:3000 \
 *     --count 1000 \
 *     --concurrency 16 \
 *     --fraud-ratio 0.02 \
 *     --api-key fdk_... \
 *     --tenant tenant-acme
 *
 * Or, fire a curated dataset (e.g. the first-touch demo set) instead
 * of synthetic ones — `transaction_id` and `timestamp` are rewritten
 * per send so the same file can be replayed any number of times
 * without idempotency collisions:
 *
 *   ts-node scripts/seed-load.ts \
 *     --file data/demo/sample-transactions.json \
 *     --concurrency 4
 *
 * Everything is optional. With no args, generates 100 transactions
 * to localhost with default concurrency 8 and no auth header (so it
 * only works if `RDA_REQUIRE_API_KEY=false`).
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

interface CliArgs {
  url: string;
  count: number;
  concurrency: number;
  fraudRatio: number;
  apiKey?: string;
  tenant?: string;
  file?: string;
}

const TRANSACTION_TYPES = ["CASH_IN", "CASH_OUT", "PAYMENT", "TRANSFER", "DEBIT"] as const;

function parseArgs(argv: string[]): CliArgs {
  // Default URL uses 127.0.0.1 rather than `localhost` because Node 18+
  // resolves `localhost` to ::1 (IPv6) on macOS, but Fastify binds to the
  // IPv4 loopback only. Using `localhost` produces "fetch failed →
  // connect ECONNREFUSED ::1:3000" on every request. Operators can still
  // pass `--url http://localhost:3000` if their host actually serves IPv6.
  const out: CliArgs = {
    url: "http://127.0.0.1",
    count: 100,
    concurrency: 8,
    fraudRatio: 0.02,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--url":         out.url = v; i++; break;
      case "--count":       out.count = Number(v); i++; break;
      case "--concurrency": out.concurrency = Number(v); i++; break;
      case "--fraud-ratio": out.fraudRatio = Number(v); i++; break;
      case "--api-key":     out.apiKey = v; i++; break;
      case "--tenant":      out.tenant = v; i++; break;
      case "--file":        out.file = v; i++; break;
    }
  }
  return out;
}

function loadFromFile(path: string): Record<string, unknown>[] {
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a JSON array of transactions in ${path}, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>[];
}

/**
 * Make a curated payload safe to replay: mint a fresh `transaction_id`
 * and `timestamp` so the same demo file fired twice doesn't trip the
 * idempotency-conflict / duplicate-audit paths. Anything else (the
 * `_note` comment in particular) is stripped so the body is clean
 * for the validator.
 */
function preparePayload(entry: Record<string, unknown>, nowSeconds: number): Record<string, unknown> {
  const { _note: _drop, transaction_id: _ignoreId, timestamp: _ignoreTs, ...rest } = entry;
  return {
    ...rest,
    transaction_id: randomUUID(),
    timestamp: nowSeconds,
  };
}

function generateTransaction(idx: number, fraudRatio: number): Record<string, unknown> {
  const isFraud = Math.random() < fraudRatio;
  const txType = TRANSACTION_TYPES[idx % TRANSACTION_TYPES.length];

  // Fraud-flavoured txs skew towards large CASH_OUT / TRANSFER amounts
  // to make the demo signal clear; legitimate ones are log-normal.
  const amount = isFraud
    ? 200_000 + Math.random() * 800_000
    : Math.max(50, Math.exp(Math.random() * 6) * 100);

  return {
    transaction_id: randomUUID(),
    sender_id: isFraud ? `attacker_${idx % 5}` : `user_${idx % 1000}`,
    receiver_id: isFraud ? `mule_${idx % 10}` : `user_${(idx * 7) % 1000}`,
    amount: Math.round(amount * 100) / 100,
    transaction_type: txType,
    timestamp: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400),
    segment: idx % 3 === 0 ? "high_value" : "standard",
  };
}

async function fire(args: CliArgs, payload: Record<string, unknown>): Promise<{
  status: number;
  decision?: string;
  latency_ms: number;
}> {
  const t0 = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.apiKey) headers["X-Api-Key"] = args.apiKey;
  if (args.tenant) headers["X-Tenant-Id"] = args.tenant;

  const resp = await fetch(`${args.url}/v1/predict`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: resp.status,
    decision: body.decision as string | undefined,
    latency_ms: Date.now() - t0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // File mode: load the curated dataset and replay each entry exactly
  // once. Ignores --count / --fraud-ratio since the curated set has its
  // own labelled mix of decisions.
  const curated = args.file ? loadFromFile(args.file) : null;
  const total = curated ? curated.length : args.count;
  const source = curated ? `file=${args.file}` : "synthetic";

  console.log(`Firing ${total} requests at ${args.url} (concurrency=${args.concurrency}, source=${source})`);

  const queue = Array.from({ length: total }, (_, i) => i);
  const results: { status: number; decision?: string; latency_ms: number }[] = [];

  async function worker() {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (idx === undefined) break;
      try {
        const payload = curated
          ? preparePayload(curated[idx]!, Math.floor(Date.now() / 1000))
          : generateTransaction(idx, args.fraudRatio);
        const r = await fire(args, payload);
        results.push(r);
      } catch (err) {
        results.push({ status: 0, latency_ms: 0 });
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const elapsedMs = Date.now() - t0;

  const accepted = results.filter((r) => r.decision === "ACCEPT").length;
  const declined = results.filter((r) => r.decision === "DECLINE").length;
  const review = results.filter((r) => r.decision === "REVIEW").length;
  const errors = results.filter((r) => r.status >= 400 || r.status === 0).length;

  const latencies = results.filter((r) => r.status === 200).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;

  console.log(
    `Done in ${elapsedMs}ms — ` +
    `accept=${accepted} decline=${declined} review=${review} errors=${errors} ` +
    `| p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms ` +
    `| rps≈${Math.round((results.length / elapsedMs) * 1000)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
