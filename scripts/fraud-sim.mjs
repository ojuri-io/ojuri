// Production-shaped fraud simulation. Generates a persona population
// transacting over a simulated N-day window and drives it through
// POST /v1/predict in timestamp order, recording ground truth per
// transaction so detection metrics can be computed against the
// decisions. Deterministic per (SIM_SEED, phase).
//
//   node scripts/fraud-sim.mjs --phase 1 --days 14 --out /tmp/sim-p1.jsonl
//
// Phases share the same legit population; fraud cohorts are fresh per
// phase so a post-retrain phase measures generalization, not memory.

import { createWriteStream } from "fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const PHASE = Number(args.phase ?? 1);
const DAYS = Number(args.days ?? 14);
const SCALE = Number(args.scale ?? 1);
const OUT = args.out ?? `/tmp/fraud-sim-p${PHASE}.jsonl`;
// transaction_id is UNIQUE per tenant, so a fixed id makes the second run
// of a phase collide on every row. Vary it per run; pin SIM_RUN_ID when you
// need two runs to produce byte-identical ids.
const RUN_ID = process.env.SIM_RUN_ID ?? Date.now().toString(36);
// Docker publishes only NGINX on :80; `npm run start:dev` publishes only :3000.
// Probing both means neither setup needs RDA_URL set.
const RDA_CANDIDATES = process.env.RDA_URL
  ? [process.env.RDA_URL.replace(/\/$/, "")]
  : ["http://localhost", "http://localhost:3000"];
let rdaUrl = RDA_CANDIDATES[0];

async function resolveRda() {
  for (const candidate of RDA_CANDIDATES) {
    try {
      const res = await fetch(`${candidate}/livez`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        rdaUrl = candidate;
        return;
      }
    } catch { }
  }
  console.error(`RDA is unreachable at ${RDA_CANDIDATES.join(" or ")} — is the stack up? (set RDA_URL to override)`);
  process.exit(1);
}
const TARGET_RPS = Number(process.env.SIM_RPS ?? 160);
const CONCURRENCY = Number(process.env.SIM_CONCURRENCY ?? 20);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();
const PHASE_END = PHASE === 1 ? NOW - 14 * DAY : NOW;
const PHASE_START = PHASE_END - DAYS * DAY;

let seed = (0xa11ce ^ (PHASE * 0x9e3779b9)) >>> 0;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
let popSeed = 0xa11ce;
function popRand() {
  popSeed = (popSeed * 1103515245 + 12345) & 0x7fffffff;
  return popSeed / 0x7fffffff;
}

const pick = (arr, r = rand) => arr[Math.floor(r() * arr.length)];
const between = (lo, hi, r = rand) => lo + r() * (hi - lo);
const int = (lo, hi, r = rand) => Math.floor(between(lo, hi + 1, r));
function logNormal(median, sigma, r = rand) {
  const u1 = Math.max(r(), 1e-9);
  const u2 = r();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(sigma * z);
}

const FIS = ["GTB", "ZENITH", "ACCESS", "UBA", "FIRSTBANK", "KUDA", "OPAY", "MONIEPOINT"];
const DEVICES = ["ANDROID", "IOS", "FEATURE_PHONE", "DESKTOP"];
const CHANNELS = ["MOBILE", "USSD", "WEB", "AGENT"];

function makeAccount(prefix, n, r = popRand) {
  return {
    id: `${prefix}-${String(n).padStart(5, "0")}`,
    fi: pick(FIS, r),
    device: pick(DEVICES, r),
    channel: pick(CHANNELS, r),
    ageDays: int(60, 3000, r),
    activeHour: int(8, 21, r),
  };
}

// ── shared legit population (population seed, stable across phases) ──
const N = (x) => Math.max(1, Math.round(x * SCALE));
const salary = Array.from({ length: N(2000) }, (_, i) => makeAccount("sim-salary", i));
const traders = Array.from({ length: N(200) }, (_, i) => makeAccount("sim-trader", i));
const savers = Array.from({ length: N(600) }, (_, i) => makeAccount("sim-saver", i));
const corporates = Array.from({ length: N(100) }, (_, i) => ({ ...makeAccount("sim-corp", i), ageDays: int(700, 5000, popRand) }));
const receivers = Array.from({ length: N(4000) }, (_, i) => makeAccount("sim-recv", i));
for (const s of [...salary, ...traders, ...savers]) {
  s.favorites = Array.from({ length: int(1, 5, popRand) }, () => pick(receivers, popRand));
}
for (const c of corporates) c.favorites = Array.from({ length: int(2, 6, popRand) }, () => pick(receivers, popRand));

let txSeq = 0;
function baseTx(sender, receiver, ts, overrides = {}) {
  txSeq += 1;
  return {
    transaction_id: `sim-${RUN_ID}-p${PHASE}-${String(txSeq).padStart(7, "0")}`,
    sender_id: sender.id,
    receiver_id: receiver.id,
    amount: 1000,
    transaction_type: "TRANSFER",
    timestamp: Math.round(ts),
    customer_type: "INDIVIDUAL",
    customer_nationality: "NG",
    transaction_country: "NG",
    ip_country: "NG",
    currency: "NGN",
    account_age_days: sender.ageDays,
    is_authenticated: true,
    ip_is_vpn: false,
    device_is_trusted: true,
    device_type: sender.device,
    channel: sender.channel,
    session_to_txn_seconds: int(30, 400),
    customer_fi: sender.fi,
    recipient_fi: receiver.fi,
    ...overrides,
  };
}

function dayTs(day, hourCenter) {
  const hour = Math.min(23, Math.max(0, hourCenter + int(-3, 3)));
  return PHASE_START + day * DAY + hour * HOUR + between(0, HOUR);
}

const events = []; // { tx, truth: {persona, typology|null, fraud} }
function emit(tx, persona, typology = null) {
  events.push({ tx, truth: { persona, typology, fraud: typology !== null } });
}

// ── legit behaviour ───────────────────────────────────────────────
for (let day = 0; day < DAYS; day++) {
  const dayOfMonth = new Date(PHASE_START + day * DAY).getDate();
  const payday = dayOfMonth >= 24 && dayOfMonth <= 28;

  for (const p of salary) {
    let n = rand() < 0.35 ? 0 : int(1, 2);
    if (payday) n += int(1, 3);
    for (let i = 0; i < n; i++) {
      const amt = Math.min(500_000, Math.round(logNormal(9_000, 1.0)));
      emit(baseTx(p, rand() < 0.85 ? pick(p.favorites) : pick(receivers), dayTs(day, p.activeHour), {
        amount: Math.max(200, amt),
        transaction_type: pick(["TRANSFER", "PAYMENT", "PAYMENT"]),
      }), "salary");
    }
  }
  for (const p of traders) {
    const n = int(5, 11);
    for (let i = 0; i < n; i++) {
      emit(baseTx(p, pick(p.favorites), dayTs(day, int(7, 20)), {
        amount: Math.max(500, Math.round(logNormal(25_000, 0.8))),
        transaction_type: pick(["CASH_IN", "CASH_OUT", "TRANSFER"]),
        channel: "AGENT",
      }), "trader");
    }
  }
  for (const p of savers) {
    if (rand() < 0.3) {
      emit(baseTx(p, pick(p.favorites), dayTs(day, p.activeHour), {
        amount: Math.max(1000, Math.round(logNormal(15_000, 0.9))),
      }), "saver");
    }
  }
  for (const p of corporates) {
    if (rand() < 0.5) {
      emit(baseTx(p, pick(p.favorites), dayTs(day, 11), {
        amount: Math.round(between(200_000, 5_000_000)),
        customer_type: "CORPORATE",
        session_to_txn_seconds: int(120, 600),
      }), "corporate");
    }
  }
}

// ── fraud typologies (fresh identities per phase) ─────────────────
const F = `sim-p${PHASE}f`;

// 1. Account takeover of existing salary accounts. Half evade the
//    FATF ATO-signature rule (amount < 1M or slow session).
for (let e = 0; e < N(60); e++) {
  const victim = pick(salary);
  const day = int(1, DAYS - 1);
  const evading = e % 2 === 0;
  const burst = int(3, 6);
  for (let i = 0; i < burst; i++) {
    emit(baseTx(victim, makeAccount(`${F}-atodest`, e * 10 + i, rand), dayTs(day, 2) + i * int(60_000, 480_000), {
      amount: Math.round(evading ? between(150_000, 900_000) : between(1_100_000, 2_500_000)),
      ip_is_vpn: !evading,
      ip_country: pick(["GB", "RU", "ZA"]),
      device_is_trusted: false,
      device_type: "DESKTOP",
      is_authenticated: true,
      session_to_txn_seconds: evading ? int(45, 90) : int(3, 8),
    }), "ato-victim", evading ? "ato-evading" : "ato-blatant");
  }
}

// 2. Mule rings: victims fan in, ring cycles, then cashes out.
for (let g = 0; g < N(12); g++) {
  const members = Array.from({ length: int(3, 5) }, (_, i) => ({ ...makeAccount(`${F}-ring${g}`, i, rand), ageDays: int(5, 60, rand) }));
  const startDay = int(0, DAYS - 3);
  for (let v = 0; v < 8; v++) {
    emit(baseTx(pick(salary), members[v % members.length], dayTs(startDay, int(9, 20)), {
      amount: Math.round(between(40_000, 350_000)),
    }), "ring-victim", "ring-fanin");
  }
  for (let c = 0; c < 12; c++) {
    const from = members[c % members.length];
    const to = members[(c + 1) % members.length];
    emit(baseTx(from, to, dayTs(startDay + 1, int(0, 23)) + c * int(120_000, 900_000), {
      amount: Math.round(between(30_000, 150_000)),
      device_is_trusted: false,
    }), "ring-member", "ring-cycle");
  }
  for (let c = 0; c < 4; c++) {
    emit(baseTx(members[c % members.length], makeAccount(`${F}-ringout`, g * 10 + c, rand), dayTs(startDay + 2, int(6, 22)), {
      amount: Math.round(between(80_000, 400_000)),
      transaction_type: "CASH_OUT",
      channel: "AGENT",
      device_is_trusted: false,
    }), "ring-member", "ring-cashout");
  }
}

// 3. Fan-out mules: one account sprays many receivers within hours.
for (let m = 0; m < N(15); m++) {
  const mule = { ...makeAccount(`${F}-fanout`, m, rand), ageDays: int(3, 45, rand) };
  const start = dayTs(int(0, DAYS - 1), int(1, 5));
  const fan = int(20, 40);
  for (let i = 0; i < fan; i++) {
    emit(baseTx(mule, makeAccount(`${F}-fandest`, m * 100 + i, rand), start + i * int(60_000, 240_000), {
      amount: Math.round(between(10_000, 60_000)),
      device_is_trusted: false,
    }), "fanout-mule", "fanout");
  }
}

// 4. Structuring: half inside the FATF CASH_OUT band, half beneath it
//    (rules blind — ML has to catch the repetition).
for (let s = 0; s < N(20); s++) {
  const p = { ...makeAccount(`${F}-struct`, s, rand), ageDays: int(30, 400, rand) };
  const inBand = s % 2 === 0;
  const startDay = int(0, DAYS - 2);
  const n = int(6, 10);
  for (let i = 0; i < n; i++) {
    emit(baseTx(p, pick(receivers), dayTs(startDay + Math.floor(i / 5), int(8, 20)) + (i % 5) * int(1_800_000, 7_200_000), {
      amount: Math.round(inBand ? between(4_500_000, 4_999_000) : between(350_000, 900_000)),
      transaction_type: "CASH_OUT",
      channel: "AGENT",
    }), "structurer", inBand ? "structuring-band" : "structuring-low");
  }
}

// 5. New-account fraud: days-old account, unauthenticated, fast drain.
for (let a = 0; a < N(75); a++) {
  const acct = { ...makeAccount(`${F}-newacct`, a, rand), ageDays: int(1, 6, rand) };
  const start = dayTs(int(0, DAYS - 1), int(0, 23));
  for (let i = 0, n = int(2, 4); i < n; i++) {
    emit(baseTx(acct, makeAccount(`${F}-nadest`, a * 10 + i, rand), start + i * int(300_000, 1_800_000), {
      amount: Math.round(between(50_000, 800_000)),
      transaction_type: pick(["CASH_OUT", "TRANSFER"]),
      is_authenticated: false,
      device_is_trusted: false,
      session_to_txn_seconds: int(5, 25),
    }), "new-account", "new-account-fraud");
  }
}

// 6. APP scams: genuine victims, genuine devices, authenticated — the
//    only signal is the receiver and the amount-vs-history deviation.
const scamReceivers = Array.from({ length: 12 }, (_, i) => makeAccount(`${F}-scammer`, i, rand));
for (let v = 0; v < N(300); v++) {
  const victim = pick(salary);
  emit(baseTx(victim, pick(scamReceivers), dayTs(int(0, DAYS - 1), victim.activeHour), {
    amount: Math.round(between(50_000, 1_500_000)),
    session_to_txn_seconds: int(200, 900),
  }), "app-victim", "app-scam");
}

// ── send chronologically ──────────────────────────────────────────
events.sort((a, b) => a.tx.timestamp - b.tx.timestamp);

const out = createWriteStream(OUT);
const counts = { sent: 0, ACCEPT: 0, DECLINE: 0, REVIEW: 0, errors: 0, rateLimited: 0, duplicates: 0 };
const started = Date.now();

async function sendOne(ev) {
  try {
    const res = await fetch(`${rdaUrl}/v1/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev.tx),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      counts.errors += 1;
      // 503 and 409 are the two ways this harness silently produces a
      // scorecard the model never contributed to, so they are counted
      // apart from genuine failures.
      if (res.status === 503) counts.rateLimited += 1;
      else if (res.status === 409) counts.duplicates += 1;
      if (counts.errors <= 5) console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return;
    }
    const body = await res.json();
    counts[body.decision] = (counts[body.decision] ?? 0) + 1;
    out.write(JSON.stringify({
      id: ev.tx.transaction_id,
      ts: ev.tx.timestamp,
      amount: ev.tx.amount,
      sender: ev.tx.sender_id,
      persona: ev.truth.persona,
      typology: ev.truth.typology,
      fraud: ev.truth.fraud,
      decision: body.decision,
      source: body.decision_source,
      prob: body.fraud_probability,
      model: body.model_version,
      rule: body.rule?.name ?? null,
    }) + "\n");
  } catch (err) {
    counts.errors += 1;
    if (counts.errors <= 5) console.error(`send failed: ${err.message}`);
  }
}

await resolveRda();

console.log(`phase ${PHASE}: ${events.length} transactions over ${DAYS} simulated days → ${rdaUrl} (${TARGET_RPS} rps target)`);

let inFlight = [];
for (const ev of events) {
  inFlight.push(sendOne(ev));
  counts.sent += 1;
  if (inFlight.length >= CONCURRENCY) {
    await Promise.race(inFlight).catch(() => {});
    inFlight = inFlight.filter((p) => p.settled !== true);
    if (inFlight.length >= CONCURRENCY) {
      await Promise.all(inFlight);
      inFlight = [];
    }
  }
  const expectedElapsed = (counts.sent / TARGET_RPS) * 1000;
  const actualElapsed = Date.now() - started;
  if (actualElapsed < expectedElapsed) await new Promise((r) => setTimeout(r, expectedElapsed - actualElapsed));
  if (counts.sent % 5000 === 0) {
    console.log(`  ${counts.sent}/${events.length} (${Math.round(counts.sent / ((Date.now() - started) / 1000))} rps) A=${counts.ACCEPT} D=${counts.DECLINE} R=${counts.REVIEW} err=${counts.errors}`);
  }
}
await Promise.all(inFlight);
out.end();

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nphase ${PHASE} complete in ${mins} min`);
console.log(`  sent=${counts.sent} ACCEPT=${counts.ACCEPT} DECLINE=${counts.DECLINE} REVIEW=${counts.REVIEW} errors=${counts.errors}`);
console.log(`  ground truth: ${OUT}`);

if (counts.rateLimited || counts.duplicates) {
  console.error("");
  console.error("!! This scorecard is NOT citable — some transactions were never scored.");
  if (counts.rateLimited) {
    console.error(`   ${counts.rateLimited} hit the NGINX rate limit (503). Lower SIM_RPS below 100, source from multiple IPs, or raise the limit.`);
  }
  if (counts.duplicates) {
    console.error(`   ${counts.duplicates} were rejected as duplicate transaction_id (409). Use a fresh SIM_RUN_ID or a clean database.`);
  }
  console.error("   See docs/ARCHITECTURE.md#8-performance-characteristics");
  process.exit(1);
}
if (counts.errors > counts.sent * 0.02) process.exit(1);
