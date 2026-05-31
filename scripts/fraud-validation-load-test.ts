/**
 * Fraud-model validation load test.
 *
 * Fires a mix of legitimate transactions and labeled fraud personas at
 * /v1/predict, captures each decision with its score and reason codes,
 * and emits a JSON summary keyed by persona. Pair the output with the
 * `decisionAuditLog` table to verify the model is actually flagging the
 * patterns we expect it to flag.
 *
 * Usage:
 *   ts-node scripts/fraud-validation-load-test.ts \
 *     --url http://127.0.0.1:3000 \
 *     --legit 800 \
 *     --concurrency 16 \
 *     --out reports/load-test-results.json
 */

import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

interface CliArgs {
  url: string;
  legit: number;
  background: number;
  concurrency: number;
  apiKey?: string;
  tenant?: string;
  out: string;
}

type Persona =
  | "legit"
  | "background"
  | "mule_layering"
  | "card_testing"
  | "account_takeover"
  | "geo_anomaly"
  | "smurfing"
  | "velocity_burst"
  | "new_account_drain"
  | "romance_scam";

interface Decision {
  persona: Persona;
  transaction_id: string;
  expected: "ACCEPT" | "DECLINE" | "REVIEW";
  status: number;
  decision?: string;
  fraud_probability?: number;
  decision_source?: string;
  rule_hit?: string;
  reason_codes?: { code: string; contribution: number }[];
  latency_ms: number;
  error?: string;
}

const TXN_TYPES = ["CASH_IN", "CASH_OUT", "PAYMENT", "TRANSFER", "DEBIT"] as const;

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    url: "http://127.0.0.1:3000",
    legit: 800,
    background: 0,
    concurrency: 16,
    out: "reports/load-test-results.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--url":         out.url = v; i++; break;
      case "--legit":       out.legit = Number(v); i++; break;
      case "--background":  out.background = Number(v); i++; break;
      case "--concurrency": out.concurrency = Number(v); i++; break;
      case "--api-key":     out.apiKey = v; i++; break;
      case "--tenant":      out.tenant = v; i++; break;
      case "--out":         out.out = v; i++; break;
    }
  }
  return out;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function lognormalAmount(): number {
  // Realistic spread: pocket-money to a couple thousand
  return Math.max(0.5, Math.exp(Math.random() * 5 + 1));
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Background-traffic generator — PaySim-style legit distribution.
 *
 * Realistic mix: 35% PAYMENT (groceries / utilities), 25% CASH_IN
 * (salary / refunds), 20% TRANSFER (person-to-person), 15% CASH_OUT
 * (ATM), 5% DEBIT. Lognormal amounts skewed small. Used to measure
 * precision: every flagged transaction in this stream is a false
 * positive.
 */
function backgroundLegitTxn(i: number): Job {
  const typeRoll = Math.random();
  const txType =
    typeRoll < 0.35 ? "PAYMENT" :
    typeRoll < 0.60 ? "CASH_IN" :
    typeRoll < 0.80 ? "TRANSFER" :
    typeRoll < 0.95 ? "CASH_OUT" : "DEBIT";
  const country = pick(COUNTRIES_LOW_RISK);
  return {
    persona: "background",
    expected: "ACCEPT",
    payload: {
      transaction_id: randomUUID(),
      sender_id: `bg_user_${i % 5000}`,
      receiver_id: txType === "CASH_IN" ? `bg_payer_${i % 200}` : `bg_recipient_${(i * 11) % 8000}`,
      amount: Math.round(lognormalAmount() * 100) / 100,
      transaction_type: txType,
      timestamp: nowS(),
      segment: "standard",
      channel: pick(["MOBILE", "WEB", "POS", "AGENT"]),
      currency: "USD",
      is_authenticated: true,
      device_is_trusted: Math.random() < 0.9,
      account_age_days: 180 + Math.floor(Math.random() * 2000),
      transaction_country: country,
      ip_country: country,
      is_recurring: Math.random() < 0.1,
      wallet_balance: 1000 + Math.random() * 9000,
      // Realistic legit session length — users typically dwell 20s-10min
      // before submitting a payment. Without this the field defaults to 0
      // (visually identical to a fraud "1-second burst") and any model
      // trained on session_to_txn_seconds will flag legit as fraud.
      session_to_txn_seconds: 20 + Math.floor(Math.random() * 580),
    },
  };
}

/* ------------------------- Persona generators ------------------------- */

interface Job {
  persona: Persona;
  expected: "ACCEPT" | "DECLINE" | "REVIEW";
  payload: Record<string, unknown>;
  /** Inter-event delay (ms) before firing this job, simulating realistic pacing within a burst. */
  delayBeforeMs?: number;
  /** Run inside a sequential group, not in the shared worker pool. */
  groupKey?: string;
}

const COUNTRIES_LOW_RISK = ["US", "CA", "GB", "DE", "FR", "AU", "NL"];
const COUNTRIES_HIGH_RISK = ["RU", "KP", "IR", "VE", "BY"];

function legitTxn(i: number): Job {
  const senderPool = 600;
  const receiverPool = 800;
  const senderId = `legit_user_${i % senderPool}`;
  const receiverId = `legit_merchant_${(i * 7) % receiverPool}`;
  const country = pick(COUNTRIES_LOW_RISK);
  return {
    persona: "legit",
    expected: "ACCEPT",
    payload: {
      transaction_id: randomUUID(),
      sender_id: senderId,
      receiver_id: receiverId,
      amount: Math.round(lognormalAmount() * 100) / 100,
      transaction_type: pick(TXN_TYPES),
      timestamp: nowS(),
      segment: i % 5 === 0 ? "high_value" : "standard",
      channel: pick(["MOBILE", "WEB", "POS"]),
      currency: "USD",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 365 + (i % 1500),
      transaction_country: country,
      ip_country: country,
      is_recurring: i % 13 === 0,
      session_to_txn_seconds: 20 + Math.floor(Math.random() * 580),
    },
  };
}

/** Mule layering — one originator splits money across N mule receivers in quick succession. */
function muleLayeringBurst(seed: number): Job[] {
  const attacker = `attacker_layering_${seed}`;
  const jobs: Job[] = [];
  const mules = Array.from({ length: 6 }, (_, i) => `mule_${seed}_${i}`);
  for (let i = 0; i < mules.length; i++) {
    jobs.push({
      persona: "mule_layering",
      expected: "DECLINE",
      delayBeforeMs: 80,
      groupKey: `mule_${seed}`,
      payload: {
        transaction_id: randomUUID(),
        sender_id: attacker,
        receiver_id: mules[i],
        amount: 180000 + Math.random() * 120000,
        transaction_type: "TRANSFER",
        timestamp: nowS(),
        segment: "high_value",
        channel: "WEB",
        currency: "USD",
        is_authenticated: true,
        device_is_trusted: false,
        account_age_days: 12,
        transaction_country: "US",
        ip_country: "US",
        session_to_txn_seconds: 4,
      },
    });
  }
  return jobs;
}

/** Card testing — many tiny PAYMENTs to "giftcard"-shaped merchants from an unknown IP. */
function cardTestingBurst(seed: number): Job[] {
  const attacker = `cardtester_${seed}`;
  const jobs: Job[] = [];
  for (let i = 0; i < 12; i++) {
    jobs.push({
      persona: "card_testing",
      expected: "DECLINE",
      delayBeforeMs: 40,
      groupKey: `cardtest_${seed}`,
      payload: {
        transaction_id: randomUUID(),
        sender_id: attacker,
        receiver_id: `merchant_giftcards_${i}`,
        amount: 1 + Math.random() * 5,
        transaction_type: "PAYMENT",
        timestamp: nowS(),
        segment: "standard",
        channel: "WEB",
        currency: "USD",
        is_authenticated: false,
        device_is_trusted: false,
        ip_is_vpn: true,
        transaction_country: "US",
        ip_country: pick(COUNTRIES_HIGH_RISK),
        session_to_txn_seconds: 2,
      },
    });
  }
  return jobs;
}

/** Account takeover — newly authenticated session immediately wires out a large amount. */
function accountTakeoverBurst(seed: number): Job[] {
  const victim = `victim_${seed}`;
  return [
    {
      persona: "account_takeover",
      expected: "DECLINE",
      payload: {
        transaction_id: randomUUID(),
        sender_id: victim,
        receiver_id: `mule_ato_${seed}`,
        amount: 75000 + Math.random() * 100000,
        transaction_type: "TRANSFER",
        timestamp: nowS(),
        segment: "high_value",
        channel: "WEB",
        currency: "USD",
        is_authenticated: true,
        device_is_trusted: false,
        account_age_days: 1100,
        ip_is_vpn: true,
        transaction_country: "US",
        ip_country: pick(COUNTRIES_HIGH_RISK),
        session_to_txn_seconds: 1,
      },
    },
  ];
}

/** Geographic anomaly — customer's home country differs from transaction/IP country at odd hour. */
function geoAnomalyTxn(seed: number): Job {
  return {
    persona: "geo_anomaly",
    expected: "DECLINE",
    payload: {
      transaction_id: randomUUID(),
      sender_id: `geo_user_${seed}`,
      receiver_id: `merchant_unknown_${seed}`,
      amount: 2500 + Math.random() * 5000,
      transaction_type: "PAYMENT",
      timestamp: nowS(),
      segment: "high_value",
      channel: "WEB",
      currency: "USD",
      is_authenticated: false,
      transaction_country: "CA",
      destination_country: "CA",
      ip_country: pick(COUNTRIES_HIGH_RISK),
      device_is_trusted: false,
    },
  };
}

/** Smurfing — many small structured TRANSFERs from one sender, just below a threshold. */
function smurfingBurst(seed: number): Job[] {
  const attacker = `smurf_${seed}`;
  const jobs: Job[] = [];
  for (let i = 0; i < 10; i++) {
    jobs.push({
      persona: "smurfing",
      expected: "DECLINE",
      delayBeforeMs: 60,
      groupKey: `smurf_${seed}`,
      payload: {
        transaction_id: randomUUID(),
        sender_id: attacker,
        receiver_id: `recipient_smurf_${seed}_${i}`,
        amount: 9500 + Math.random() * 400,
        transaction_type: "TRANSFER",
        timestamp: nowS(),
        segment: "high_value",
        channel: "WEB",
        currency: "USD",
        is_authenticated: true,
        device_is_trusted: false,
        account_age_days: 60,
      },
    });
  }
  return jobs;
}

/** Velocity burst — same sender hammering /v1/predict with high-amount TXs in <1s. */
function velocityBurst(seed: number): Job[] {
  const attacker = `velocity_${seed}`;
  const jobs: Job[] = [];
  for (let i = 0; i < 8; i++) {
    jobs.push({
      persona: "velocity_burst",
      expected: "DECLINE",
      delayBeforeMs: 20,
      groupKey: `velocity_${seed}`,
      payload: {
        transaction_id: randomUUID(),
        sender_id: attacker,
        receiver_id: `target_${i}`,
        amount: 50000 + Math.random() * 200000,
        transaction_type: "CASH_OUT",
        timestamp: nowS(),
        segment: "high_value",
        channel: "AGENT",
        currency: "USD",
        is_authenticated: true,
        device_is_trusted: false,
        account_age_days: 30,
      },
    });
  }
  return jobs;
}

function newAccountDrainTxn(seed: number): Job {
  return {
    persona: "new_account_drain",
    expected: "DECLINE",
    payload: {
      transaction_id: randomUUID(),
      sender_id: `brandnew_${seed}`,
      receiver_id: `mule_drain_${seed}`,
      amount: 40000 + Math.random() * 60000,
      transaction_type: "TRANSFER",
      timestamp: nowS(),
      segment: "high_value",
      channel: "WEB",
      currency: "USD",
      is_authenticated: true,
      device_is_trusted: false,
      account_age_days: 0,
    },
  };
}

/** Romance scam — older account sends repeated mid-size international transfers to one foreign recipient. */
function romanceScamBurst(seed: number): Job[] {
  const victim = `romance_victim_${seed}`;
  const scammer = `foreign_partner_${seed}`;
  const jobs: Job[] = [];
  for (let i = 0; i < 5; i++) {
    jobs.push({
      persona: "romance_scam",
      expected: "REVIEW",
      delayBeforeMs: 120,
      groupKey: `romance_${seed}`,
      payload: {
        transaction_id: randomUUID(),
        sender_id: victim,
        receiver_id: scammer,
        amount: 1500 + Math.random() * 2500,
        transaction_type: "TRANSFER",
        timestamp: nowS(),
        segment: "high_value",
        channel: "WEB",
        currency: "USD",
        is_authenticated: true,
        device_is_trusted: true,
        account_age_days: 2200,
        transaction_country: "US",
        destination_country: "NG",
        ip_country: "US",
      },
    });
  }
  return jobs;
}

/* ------------------------- HTTP firing ------------------------- */

async function fire(args: CliArgs, job: Job): Promise<Decision> {
  const t0 = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.apiKey) headers["X-Api-Key"] = args.apiKey;
  if (args.tenant) headers["X-Tenant-Id"] = args.tenant;
  try {
    const resp = await fetch(`${args.url}/v1/predict`, {
      method: "POST",
      headers,
      body: JSON.stringify(job.payload),
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const ruleHit = (body.rule_hit as { name?: string } | undefined)?.name;
    return {
      persona: job.persona,
      transaction_id: job.payload.transaction_id as string,
      expected: job.expected,
      status: resp.status,
      decision: body.decision as string | undefined,
      fraud_probability: body.fraud_probability as number | undefined,
      decision_source: body.decision_source as string | undefined,
      rule_hit: ruleHit,
      reason_codes: body.reason_codes as { code: string; contribution: number }[] | undefined,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      persona: job.persona,
      transaction_id: job.payload.transaction_id as string,
      expected: job.expected,
      status: 0,
      latency_ms: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

/* ------------------------- Orchestration ------------------------- */

async function runGroup(args: CliArgs, jobs: Job[], results: Decision[]): Promise<void> {
  // Run sequentially so velocity/burst patterns truly land within a tight window.
  for (const j of jobs) {
    if (j.delayBeforeMs) await new Promise((r) => setTimeout(r, j.delayBeforeMs));
    results.push(await fire(args, j));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Build job graph.
  const legitJobs: Job[] = Array.from({ length: args.legit }, (_, i) => legitTxn(i));
  const backgroundJobs: Job[] = Array.from({ length: args.background }, (_, i) => backgroundLegitTxn(i));

  const groups: Job[][] = [];
  for (let s = 0; s < 8; s++) groups.push(muleLayeringBurst(s));
  for (let s = 0; s < 6; s++) groups.push(cardTestingBurst(s));
  for (let s = 0; s < 10; s++) groups.push(accountTakeoverBurst(s));
  for (let s = 0; s < 6; s++) groups.push(smurfingBurst(s));
  for (let s = 0; s < 6; s++) groups.push(velocityBurst(s));
  for (let s = 0; s < 8; s++) groups.push(romanceScamBurst(s));

  const standaloneJobs: Job[] = [
    ...Array.from({ length: 12 }, (_, i) => geoAnomalyTxn(i)),
    ...Array.from({ length: 10 }, (_, i) => newAccountDrainTxn(i)),
    ...backgroundJobs,
  ];

  const totalCount =
    legitJobs.length +
    groups.reduce((acc, g) => acc + g.length, 0) +
    standaloneJobs.length;

  console.log(
    `Plan: ${legitJobs.length} legit + ${groups.length} fraud groups (${groups.reduce(
      (a, g) => a + g.length,
      0,
    )} fraud TXs) + ${standaloneJobs.length} standalone fraud = ${totalCount} total. Concurrency=${args.concurrency}.`,
  );

  const results: Decision[] = [];

  // Shared pool processes legit + standalone in parallel; fraud groups run as
  // sequential coroutines also pulled from the shared concurrency budget.
  const sharedQueue: Job[] = [...legitJobs, ...standaloneJobs];
  const groupQueue: Job[][] = [...groups];

  const t0 = Date.now();
  async function worker() {
    for (;;) {
      const grp = groupQueue.shift();
      if (grp) {
        await runGroup(args, grp, results);
        continue;
      }
      const single = sharedQueue.shift();
      if (!single) return;
      results.push(await fire(args, single));
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const elapsedMs = Date.now() - t0;

  // Aggregate per-persona.
  const personas = Array.from(new Set(results.map((r) => r.persona))) as Persona[];
  const summary: Record<string, unknown> = { elapsed_ms: elapsedMs, total: results.length, personas: {} };
  for (const p of personas) {
    const rs = results.filter((r) => r.persona === p);
    const accept = rs.filter((r) => r.decision === "ACCEPT").length;
    const decline = rs.filter((r) => r.decision === "DECLINE").length;
    const review = rs.filter((r) => r.decision === "REVIEW").length;
    const errors = rs.filter((r) => r.status >= 400 || r.status === 0).length;
    const probs = rs
      .map((r) => r.fraud_probability)
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    const med = probs[Math.floor(probs.length / 2)];
    const expected = rs[0]?.expected;
    let flagged = 0;
    if (expected === "DECLINE") flagged = decline;
    else if (expected === "REVIEW") flagged = review + decline;
    else flagged = accept;
    const detectionRate = rs.length === 0 ? 0 : flagged / rs.length;
    (summary.personas as Record<string, unknown>)[p] = {
      count: rs.length,
      expected,
      accept,
      decline,
      review,
      errors,
      detection_rate: Number(detectionRate.toFixed(4)),
      median_score: med ?? null,
      decision_sources: rs.reduce<Record<string, number>>((acc, r) => {
        if (r.decision_source) acc[r.decision_source] = (acc[r.decision_source] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  const lat = results
    .filter((r) => r.status === 200)
    .map((r) => r.latency_ms)
    .sort((a, b) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  summary.latency_ms = { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
  summary.throughput_rps = Math.round((results.length / elapsedMs) * 1000);

  // Write JSON file with full decisions for downstream analysis.
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, decisions: results }, null, 2));

  console.log("Per-persona summary:");
  for (const p of personas) {
    const s = (summary.personas as Record<string, Record<string, unknown>>)[p]!;
    console.log(
      `  ${p.padEnd(20)} n=${String(s.count).padStart(4)} ` +
        `decision A/D/R=${s.accept}/${s.decline}/${s.review} ` +
        `expected=${s.expected} hit-rate=${s.detection_rate} median_score=${s.median_score}`,
    );
  }
  console.log(`Latency p50/p95/p99 = ${q(0.5)}/${q(0.95)}/${q(0.99)} ms · ~${summary.throughput_rps} req/s`);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
