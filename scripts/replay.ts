/**
 * Decision replay CLI.
 *
 * Reads recent rows from `decisionAuditLog`, replays the original
 * request payloads against a target RDA URL (typically a candidate
 * deployment with a new model), and prints a confusion-style summary
 * comparing the original decision to the replayed one.
 *
 * Usage:
 *
 *   ts-node scripts/replay.ts \
 *     --target http://localhost:3000 \
 *     --since "2026-05-01" \
 *     --limit 5000 \
 *     --api-key fdk_...
 *
 * Useful for: "would the candidate model have behaved differently
 * on yesterday's traffic?". Does not modify the audit log — the
 * candidate's predictions are written to their own audit rows, so
 * downstream comparison can be done in SQL.
 */

import knex, { Knex } from "knex";
import "dotenv/config";

interface Args {
  target: string;
  since?: string;
  limit: number;
  apiKey?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { target: "http://localhost:3000", limit: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--target":  out.target = v; i++; break;
      case "--since":   out.since = v; i++; break;
      case "--limit":   out.limit = Number(v); i++; break;
      case "--api-key": out.apiKey = v; i++; break;
    }
  }
  return out;
}

function db(): Knex {
  return knex({
    client: process.env.DB_CLIENT || "pg",
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const k = db();

  const q = k("decisionAuditLog")
    .select(
      "transactionId",
      "senderId",
      "receiverId",
      "amount",
      "transactionType",
      "segment",
      "finalDecision as originalDecision",
      "championScore as originalScore",
      "createdAt"
    )
    .orderBy("createdAt", "desc")
    .limit(args.limit);

  if (args.since) q.andWhere("createdAt", ">=", args.since);

  const rows: any[] = await q;
  if (rows.length === 0) {
    console.log("No audit rows to replay — exiting.");
    await k.destroy();
    return;
  }

  console.log(`Replaying ${rows.length} decisions against ${args.target}…`);

  const counts: Record<string, Record<string, number>> = {};
  let errors = 0;

  for (const r of rows) {
    const payload = {
      transaction_id: r.transactionId,
      sender_id: r.senderId,
      receiver_id: r.receiverId ?? "unknown",
      amount: Number(r.amount),
      transaction_type: r.transactionType ?? "TRANSFER",
      timestamp: Math.floor(new Date(r.createdAt).getTime() / 1000),
      segment: r.segment,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (args.apiKey) headers["X-Api-Key"] = args.apiKey;

    try {
      const resp = await fetch(`${args.target}/v1/predict`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await resp.json();
      const replayed = (body as any).decision ?? "ERROR";

      counts[r.originalDecision] ??= {};
      counts[r.originalDecision][replayed] = (counts[r.originalDecision][replayed] ?? 0) + 1;
    } catch {
      errors++;
    }
  }

  console.log("\nOriginal -> Replayed");
  for (const [orig, by] of Object.entries(counts)) {
    for (const [rep, n] of Object.entries(by)) {
      console.log(`  ${orig.padEnd(8)} -> ${rep.padEnd(8)} : ${n}`);
    }
  }
  if (errors > 0) console.log(`(${errors} network errors)`);

  await k.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
