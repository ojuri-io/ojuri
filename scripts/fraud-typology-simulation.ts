/**
 * Independent fraud-typology simulation.
 *
 * Distinct from scripts/fraud-validation-load-test.ts in three ways:
 *
 * 1. Typology selection is driven by FATF / Wolfsberg AML / UK Finance APP
 *    scam reports — not by the features we know the model was trained on.
 *    The hardest cases (APP scam, BEC redirect, slow-burn mule) deliberately
 *    look legit on the surface and require the model + PAA graph + rules
 *    to combine.
 * 2. Legit baseline uses behaviour archetypes (payroll, bill, recurring P2P,
 *    merchant, high-value salary) instead of generic random PaySim mix —
 *    we want to know if the model false-positives on realistic legit shapes.
 * 3. Each transaction carries a ground-truth label (FRAUD | LEGIT) plus a
 *    typology tag, so analysis can compute precision/recall per typology.
 *
 * Usage:
 *   ts-node scripts/fraud-typology-simulation.ts \
 *     --url http://127.0.0.1:80 \
 *     --legit 9500 --fraud 500 \
 *     --concurrency 1 \
 *     --out reports/sim-sequential.jsonl
 */

import { randomUUID } from "crypto";
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { request as httpRequest, Agent as HttpAgent } from "http";
import { request as httpsRequest, Agent as HttpsAgent } from "https";
import { URL } from "url";

const httpKeepAlive = new HttpAgent({ keepAlive: true, maxSockets: 256 });
const httpsKeepAlive = new HttpsAgent({ keepAlive: true, maxSockets: 256 });

function postJson(urlStr: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        agent: isHttps ? httpsKeepAlive : httpKeepAlive,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

interface CliArgs {
  url: string;
  legit: number;
  fraud: number;
  concurrency: number;
  out: string;
  apiKey?: string;
}

type GroundTruth = "FRAUD" | "LEGIT";

type Typology =
  // Fraud typologies — FATF / Wolfsberg / UK Finance reference
  | "app_scam_purchase"          // Authorised Push Payment — victim authorises purchase that doesn't exist
  | "app_scam_impersonation"     // APP — fake bank/police impersonator
  | "ato_velocity"               // Account takeover with credential stuffing + fast drain
  | "synthetic_id_bustout"       // Aged synthetic identity activates with large CASH_OUT
  | "money_mule_smurfing"        // Mule receives multiple small deposits then large CASH_OUT
  | "bec_invoice_redirect"       // Corporate payment to new beneficiary that mimics old one
  | "refund_to_different_acct"   // Small purchase → refund (CASH_IN) to new account
  | "romance_scam_payout"        // Recurring transfers to new beneficiary in high-risk corridor
  | "first_party_dispute"        // Customer-initiated transactions later disputed
  // Legit archetypes
  | "legit_payroll"
  | "legit_recurring_bill"
  | "legit_p2p_repeat"
  | "legit_merchant_small"
  | "legit_atm_withdrawal"
  | "legit_high_value_salary"
  | "legit_p2p_first_time"       // Legit but first-time recipient — should NOT flag
  | "legit_travel"               // Legit transaction abroad — should NOT flag if device trusted
  ;

interface Job {
  ground_truth: GroundTruth;
  typology: Typology;
  payload: Record<string, unknown>;
}

interface ResultRecord {
  ground_truth: GroundTruth;
  typology: Typology;
  transaction_id: string;
  status: number;
  fraud_probability?: number;
  decision?: string;
  decision_source?: string;
  threshold?: number;
  rule_hit?: string;
  latency_ms: number;
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    url: "http://127.0.0.1:80",
    legit: 9500,
    fraud: 500,
    concurrency: 1,
    out: "reports/sim.jsonl",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--url":         out.url = v; i++; break;
      case "--legit":       out.legit = Number(v); i++; break;
      case "--fraud":       out.fraud = Number(v); i++; break;
      case "--concurrency": out.concurrency = Number(v); i++; break;
      case "--out":         out.out = v; i++; break;
      case "--api-key":     out.apiKey = v; i++; break;
    }
  }
  return out;
}

const COUNTRIES_HIGH_RISK = ["RU", "KP", "IR", "VE", "BY", "MM", "SY"];

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }
function nowMs(): number { return Date.now(); }
function uniform(min: number, max: number): number { return min + Math.random() * (max - min); }
function round2(x: number): number { return Math.round(x * 100) / 100; }

/* ---------------------- LEGIT ARCHETYPES ---------------------- */

function legitPayroll(i: number): Job {
  return {
    ground_truth: "LEGIT", typology: "legit_payroll",
    payload: {
      transaction_id: `lp-${randomUUID()}`,
      sender_id: `employer_${i % 50}`,
      receiver_id: `emp_${i % 3000}`,
      amount: round2(uniform(1500, 6500)),
      transaction_type: "CASH_IN",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 365 + (i % 2000),
      transaction_country: "US", ip_country: "US",
      is_recurring: true,
      session_to_txn_seconds: Math.floor(uniform(30, 300)),
      wallet_balance: round2(uniform(500, 8000)),
      is_inflow: true,
    },
  };
}

function legitRecurringBill(i: number): Job {
  return {
    ground_truth: "LEGIT", typology: "legit_recurring_bill",
    payload: {
      transaction_id: `lb-${randomUUID()}`,
      sender_id: `bill_payer_${i % 4000}`,
      receiver_id: `merchant_utility_${i % 20}`,
      amount: round2(uniform(35, 450)),
      transaction_type: "PAYMENT",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 200 + (i % 1500),
      transaction_country: "US", ip_country: "US",
      is_recurring: true,
      session_to_txn_seconds: Math.floor(uniform(45, 240)),
      wallet_balance: round2(uniform(200, 4000)),
    },
  };
}

function legitP2pRepeat(i: number): Job {
  // Same sender → same receiver pair across many calls
  const senderId = `p2p_user_${i % 1500}`;
  const receiverId = `p2p_user_${(i * 7 + 3) % 1500}`;
  return {
    ground_truth: "LEGIT", typology: "legit_p2p_repeat",
    payload: {
      transaction_id: `lp2-${randomUUID()}`,
      sender_id: senderId,
      receiver_id: receiverId,
      amount: round2(uniform(10, 300)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "MOBILE",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 100 + (i % 1800),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(15, 180)),
      wallet_balance: round2(uniform(50, 2000)),
    },
  };
}

function legitMerchantSmall(i: number): Job {
  return {
    ground_truth: "LEGIT", typology: "legit_merchant_small",
    payload: {
      transaction_id: `lm-${randomUUID()}`,
      sender_id: `shopper_${i % 5000}`,
      receiver_id: `merchant_retail_${i % 800}`,
      amount: round2(uniform(2, 95)),
      transaction_type: "PAYMENT",
      timestamp: nowMs(),
      currency: "USD",
      channel: pick(["POS", "WEB", "MOBILE"]),
      is_authenticated: true,
      device_is_trusted: Math.random() < 0.95,
      account_age_days: 100 + (i % 2200),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(20, 600)),
    },
  };
}

function legitAtmWithdrawal(i: number): Job {
  return {
    ground_truth: "LEGIT", typology: "legit_atm_withdrawal",
    payload: {
      transaction_id: `la-${randomUUID()}`,
      sender_id: `cardholder_${i % 4000}`,
      receiver_id: `atm_${i % 600}`,
      amount: round2(uniform(20, 400)),
      transaction_type: "CASH_OUT",
      timestamp: nowMs(),
      currency: "USD",
      channel: "POS",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 200 + (i % 2000),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(5, 60)),
      wallet_balance: round2(uniform(200, 5000)),
    },
  };
}

function legitHighValueSalary(i: number): Job {
  return {
    ground_truth: "LEGIT", typology: "legit_high_value_salary",
    payload: {
      transaction_id: `lhv-${randomUUID()}`,
      sender_id: `corp_payroll_${i % 30}`,
      receiver_id: `exec_${i % 200}`,
      amount: round2(uniform(8000, 35000)),  // Senior/exec payroll
      transaction_type: "CASH_IN",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 800 + (i % 2500),
      transaction_country: "US", ip_country: "US",
      is_recurring: true,
      session_to_txn_seconds: Math.floor(uniform(45, 240)),
      is_inflow: true,
    },
  };
}

function legitP2pFirstTime(i: number): Job {
  // First-time recipient but everything else looks legit — friend's wedding gift, etc.
  return {
    ground_truth: "LEGIT", typology: "legit_p2p_first_time",
    payload: {
      transaction_id: `lp1-${randomUUID()}`,
      sender_id: `p2p_sender_${i % 3000}`,
      receiver_id: `p2p_recipient_new_${i}`,  // unique, never seen before
      amount: round2(uniform(50, 800)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "MOBILE",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 500 + (i % 1500),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(60, 400)),
      wallet_balance: round2(uniform(800, 5000)),
    },
  };
}

function legitTravel(i: number): Job {
  // Customer abroad — should not flag if device + auth check out
  const country = pick(["GB", "FR", "DE", "JP", "AU", "SG"]);
  return {
    ground_truth: "LEGIT", typology: "legit_travel",
    payload: {
      transaction_id: `lt-${randomUUID()}`,
      sender_id: `traveller_${i % 800}`,
      receiver_id: `merchant_intl_${i % 400}`,
      amount: round2(uniform(15, 350)),
      transaction_type: "PAYMENT",
      timestamp: nowMs(),
      currency: "USD",
      channel: pick(["POS", "MOBILE"]),
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 400 + (i % 1800),
      transaction_country: country,
      ip_country: country,
      session_to_txn_seconds: Math.floor(uniform(30, 300)),
    },
  };
}

/* ---------------------- FRAUD TYPOLOGIES ---------------------- */

/** APP scam — purchase scam. Victim authorises payment for goods that never arrive.
 *  This is the HARDEST case in 2024-25 UK Finance reports: device is trusted,
 *  session is normal, customer is authenticated. Only signal: brand-new recipient
 *  and amount is higher than the sender's usual. */
function appScamPurchase(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "app_scam_purchase",
    payload: {
      transaction_id: `as1-${randomUUID()}`,
      sender_id: `victim_app_${i}`,
      receiver_id: `scammer_marketplace_${i}`,   // brand-new mule account
      amount: round2(uniform(400, 4500)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",  // Web — they clicked a link
      is_authenticated: true,
      device_is_trusted: true,    // their own device
      account_age_days: 700 + (i % 1200),
      transaction_country: "US", ip_country: "US",
      // Session length normal-ish — they were on the scam site for a while
      session_to_txn_seconds: Math.floor(uniform(120, 600)),
      wallet_balance: round2(uniform(2000, 10000)),
    },
  };
}

/** APP scam — bank impersonation. Higher urgency, shorter session, but otherwise legit signals. */
function appScamImpersonation(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "app_scam_impersonation",
    payload: {
      transaction_id: `as2-${randomUUID()}`,
      sender_id: `victim_imp_${i}`,
      receiver_id: `mule_safeacct_${i}`,
      amount: round2(uniform(800, 7500)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "MOBILE",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 1200 + (i % 800),
      transaction_country: "US", ip_country: "US",
      // Urgent — scammer rushes them
      session_to_txn_seconds: Math.floor(uniform(15, 90)),
      wallet_balance: round2(uniform(3000, 12000)),
    },
  };
}

/** Account takeover with velocity — stolen credentials, fast TRANSFER from new device. */
function atoVelocity(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "ato_velocity",
    payload: {
      transaction_id: `ato-${randomUUID()}`,
      sender_id: `ato_victim_${i}`,
      receiver_id: `mule_ato_${i}`,
      amount: round2(uniform(15000, 80000)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: false,
      account_age_days: 1500 + (i % 800),
      transaction_country: "US",
      ip_country: pick(COUNTRIES_HIGH_RISK),
      ip_is_vpn: true,
      session_to_txn_seconds: Math.floor(uniform(1, 8)),
      wallet_balance: round2(uniform(20000, 100000)),
    },
  };
}

/** Synthetic identity bust-out — aged account suddenly drains. */
function syntheticIdBustout(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "synthetic_id_bustout",
    payload: {
      transaction_id: `sid-${randomUUID()}`,
      sender_id: `synth_${i}`,
      receiver_id: `cashout_agent_${i % 100}`,
      amount: round2(uniform(25000, 150000)),
      transaction_type: "CASH_OUT",
      timestamp: nowMs(),
      currency: "USD",
      channel: "AGENT",
      is_authenticated: true,
      device_is_trusted: false,
      // Synthetic IDs age — that's the whole point
      account_age_days: 240 + (i % 360),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(5, 30)),
      wallet_balance: round2(uniform(25000, 200000)),
    },
  };
}

/** Money mule smurfing — multiple small deposits to one mule then CASH_OUT */
function moneyMuleSmurfing(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "money_mule_smurfing",
    payload: {
      transaction_id: `mule-${randomUUID()}`,
      sender_id: `mule_${i % 80}`,           // mule reused across batch
      receiver_id: `cashout_${i % 200}`,
      amount: round2(uniform(8500, 9900)),    // structured under reporting limit
      transaction_type: "CASH_OUT",
      timestamp: nowMs(),
      currency: "USD",
      channel: "AGENT",
      is_authenticated: true,
      device_is_trusted: false,
      account_age_days: 30 + (i % 90),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(2, 20)),
    },
  };
}

/** BEC / invoice redirect — corporate paying out to a "new" supplier account that mimics old one */
function becInvoiceRedirect(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "bec_invoice_redirect",
    payload: {
      transaction_id: `bec-${randomUUID()}`,
      sender_id: `corp_finance_${i % 40}`,
      receiver_id: `supplier_redirect_${i}`,  // Brand-new beneficiary, looks similar to legit
      amount: round2(uniform(25000, 200000)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 2000,
      transaction_country: "US",
      destination_country: pick(["HK", "AE", "SG", "GB"]),  // common BEC corridors
      ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(180, 900)),  // normal corporate finance session
      customer_type: "CORPORATE",
    },
  };
}

/** Refund-to-different-account — CASH_IN that's actually a refund redirected */
function refundToDifferentAcct(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "refund_to_different_acct",
    payload: {
      transaction_id: `rfd-${randomUUID()}`,
      sender_id: `merchant_returns_${i % 60}`,
      receiver_id: `fraudster_${i}`,          // not original buyer
      amount: round2(uniform(800, 6000)),     // refund inflated above original
      transaction_type: "CASH_IN",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: false,
      account_age_days: 20 + (i % 60),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(10, 60)),
      is_inflow: true,
    },
  };
}

/** Romance scam payout — periodic transfers to recipient in high-risk corridor */
function romanceScamPayout(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "romance_scam_payout",
    payload: {
      transaction_id: `rom-${randomUUID()}`,
      sender_id: `victim_rom_${i % 200}`,
      receiver_id: `scammer_rom_${i % 80}`,
      amount: round2(uniform(500, 5000)),
      transaction_type: "TRANSFER",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 1500 + (i % 800),  // legit aged victim account
      transaction_country: "US",
      destination_country: pick(["NG", "GH", "MY", "PH"]),  // typical corridors
      ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(60, 300)),
      wallet_balance: round2(uniform(2000, 15000)),
    },
  };
}

/** First-party fraud — customer makes purchase, later disputes; pattern is normal-looking activity. */
function firstPartyDispute(i: number): Job {
  return {
    ground_truth: "FRAUD", typology: "first_party_dispute",
    payload: {
      transaction_id: `fpd-${randomUUID()}`,
      sender_id: `fpf_actor_${i % 100}`,
      receiver_id: `merchant_giftcard_${i % 50}`,  // gift cards: hard-to-recall liquid
      amount: round2(uniform(150, 1500)),
      transaction_type: "PAYMENT",
      timestamp: nowMs(),
      currency: "USD",
      channel: "WEB",
      is_authenticated: true,
      device_is_trusted: true,
      account_age_days: 800 + (i % 1000),
      transaction_country: "US", ip_country: "US",
      session_to_txn_seconds: Math.floor(uniform(45, 180)),
    },
  };
}

/* ---------------------- ORCHESTRATION ---------------------- */

const LEGIT_BUILDERS = [
  legitPayroll,
  legitRecurringBill,
  legitP2pRepeat,
  legitMerchantSmall,
  legitAtmWithdrawal,
  legitHighValueSalary,
  legitP2pFirstTime,
  legitTravel,
] as const;

const FRAUD_BUILDERS = [
  appScamPurchase,
  appScamImpersonation,
  atoVelocity,
  syntheticIdBustout,
  moneyMuleSmurfing,
  becInvoiceRedirect,
  refundToDifferentAcct,
  romanceScamPayout,
  firstPartyDispute,
] as const;

function buildJobs(args: CliArgs): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < args.legit; i++) {
    const builder = LEGIT_BUILDERS[i % LEGIT_BUILDERS.length]!;
    jobs.push(builder(i));
  }
  for (let i = 0; i < args.fraud; i++) {
    const builder = FRAUD_BUILDERS[i % FRAUD_BUILDERS.length]!;
    jobs.push(builder(i));
  }
  // Shuffle so legit and fraud are interleaved — important so PAA velocity
  // features don't all warm up on one persona at a time.
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = jobs[i]!; jobs[i] = jobs[j]!; jobs[j] = tmp;
  }
  return jobs;
}

async function fireOne(args: CliArgs, job: Job): Promise<ResultRecord> {
  const headers: { [k: string]: string } = { "content-type": "application/json" };
  if (args.apiKey) headers["x-api-key"] = args.apiKey;
  const t0 = Date.now();
  try {
    const { status, text } = await postJson(`${args.url}/v1/predict`, JSON.stringify(job.payload), headers);
    const t1 = Date.now();
    let body: any = {};
    try { body = JSON.parse(text); } catch { /* */ }
    return {
      ground_truth: job.ground_truth,
      typology: job.typology,
      transaction_id: (job.payload as any).transaction_id,
      status,
      fraud_probability: body?.fraud_probability,
      decision: body?.decision,
      decision_source: body?.decision_source,
      threshold: body?.threshold,
      rule_hit: body?.rule_hit,
      latency_ms: t1 - t0,
    };
  } catch (e: any) {
    const t1 = Date.now();
    return {
      ground_truth: job.ground_truth,
      typology: job.typology,
      transaction_id: (job.payload as any).transaction_id,
      status: -1,
      latency_ms: t1 - t0,
      error: String(e?.message ?? e),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(args);

  if (!existsSync(dirname(args.out))) mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, "");

  console.error(`firing ${jobs.length} jobs (${args.legit} legit + ${args.fraud} fraud) at concurrency=${args.concurrency} → ${args.url}`);
  const t0 = Date.now();

  const worker = async (slice: Job[]) => {
    for (const job of slice) {
      const rec = await fireOne(args, job);
      appendFileSync(args.out, JSON.stringify(rec) + "\n");
    }
  };

  // Round-robin split: each worker gets every Nth job
  const slices: Job[][] = Array.from({ length: args.concurrency }, () => []);
  jobs.forEach((j, i) => slices[i % args.concurrency]!.push(j));
  await Promise.all(slices.map(worker));

  const t1 = Date.now();
  const wallS = (t1 - t0) / 1000;
  console.error(`done in ${wallS.toFixed(1)}s — ${(jobs.length / wallS).toFixed(0)} req/s — ${args.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
