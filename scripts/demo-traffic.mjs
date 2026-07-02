const RDA_URL = (process.env.RDA_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.DEMO_API_KEY ?? "";
const TX_COUNT = Number(process.env.DEMO_TX_COUNT ?? 500);
const WAIT_SECONDS = Number(process.env.DEMO_WAIT_FOR_RDA_SECONDS ?? 0);
const RPS = 20;

const RUN_ID = Date.now().toString(36);

const FIRST_NAMES = ["Adaeze", "Chinedu", "Bola", "Emeka", "Funke", "Ibrahim", "Kemi", "Musa", "Ngozi", "Olu", "Sade", "Tunde", "Uche", "Yusuf", "Zainab", "Amaka", "Bello", "Chioma", "Damilola", "Efe"];
const LAST_NAMES = ["Okafor", "Adeyemi", "Balogun", "Eze", "Ibrahim", "Lawal", "Mohammed", "Nwosu", "Obi", "Ogunleye", "Okonkwo", "Olawale", "Onyeka", "Sanni", "Umar"];
const CHANNELS = ["MOBILE", "USSD", "WEB", "AGENT"];
const TX_TYPES = ["TRANSFER", "PAYMENT", "CASH_OUT", "CASH_IN", "DEBIT"];
const TX_TYPE_WEIGHTS = [0.4, 0.25, 0.15, 0.12, 0.08];
const DEVICE_TYPES = ["ANDROID", "IOS", "FEATURE_PHONE", "DESKTOP"];
const FIS = ["GTB", "ZENITH", "ACCESS", "UBA", "FIRSTBANK", "KUDA", "OPAY"];

let seed = 0x2f6e2b1;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function pickWeighted(items, weights) {
  let r = rand();
  for (let i = 0; i < items.length; i++) {
    if (r < weights[i]) return items[i];
    r -= weights[i];
  }
  return items[items.length - 1];
}

function logNormalAmount() {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const amount = Math.exp(9.4 + 0.9 * z);
  return Math.round(Math.min(Math.max(amount, 200), 95000) * 100) / 100;
}

function fullName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function makeAccount(prefix, n) {
  return {
    id: `${prefix}-${String(n).padStart(4, "0")}`,
    name: fullName(),
    fi: pick(FIS),
    deviceType: pick(DEVICE_TYPES),
    channel: pick(CHANNELS),
    accountAgeDays: Math.floor(30 + rand() * 2500),
  };
}

const senders = Array.from({ length: 50 }, (_, i) => makeAccount("demo-sender", i));
const receiverPool = Array.from({ length: 120 }, (_, i) => makeAccount("demo-receiver", i));
for (const sender of senders) {
  sender.receivers = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => pick(receiverPool));
}

let txSeq = 0;
function baseTx(sender, receiver, overrides = {}) {
  txSeq += 1;
  return {
    transaction_id: `demo-${RUN_ID}-${String(txSeq).padStart(5, "0")}`,
    sender_id: sender.id,
    receiver_id: receiver.id,
    amount: logNormalAmount(),
    transaction_type: pickWeighted(TX_TYPES, TX_TYPE_WEIGHTS),
    timestamp: Date.now(),
    customer_account_name: sender.name,
    beneficiary_account_name: receiver.name,
    customer_type: "INDIVIDUAL",
    account_age_days: sender.accountAgeDays,
    is_authenticated: true,
    channel: sender.channel,
    currency: "NGN",
    transaction_country: "NG",
    ip_country: "NG",
    ip_is_vpn: false,
    device_is_trusted: true,
    device_type: sender.deviceType,
    session_to_txn_seconds: Math.floor(20 + rand() * 400),
    customer_fi: sender.fi,
    recipient_fi: receiver.fi,
    ...overrides,
  };
}

function buildTransactions(count) {
  const txs = [];

  const [ringA, ringB, ringC] = [
    makeAccount("demo-ring", 1),
    makeAccount("demo-ring", 2),
    makeAccount("demo-ring", 3),
  ];
  for (let cycle = 0; cycle < 5; cycle++) {
    const hop = 40000 + Math.round(rand() * 15000);
    txs.push(baseTx(ringA, ringB, { transaction_type: "TRANSFER", amount: hop }));
    txs.push(baseTx(ringB, ringC, { transaction_type: "TRANSFER", amount: hop - 500 }));
    txs.push(baseTx(ringC, ringA, { transaction_type: "TRANSFER", amount: hop - 1000 }));
  }

  const mule = makeAccount("demo-mule", 1);
  for (let i = 0; i < 30; i++) {
    txs.push(
      baseTx(mule, makeAccount("demo-mule-out", i), {
        transaction_type: "TRANSFER",
        amount: 15000 + Math.round(rand() * 45000),
        device_is_trusted: false,
      })
    );
  }

  const vpnSender = makeAccount("demo-vpn", 1);
  for (let i = 0; i < 3; i++) {
    txs.push(
      baseTx(vpnSender, pick(receiverPool), {
        transaction_type: "TRANSFER",
        amount: 250000 + Math.round(rand() * 550000),
        ip_is_vpn: true,
        ip_country: "NL",
        device_is_trusted: false,
      })
    );
  }

  const structurer = makeAccount("demo-structuring", 1);
  for (const amount of [4900000, 4850000, 4950000, 4880000]) {
    txs.push(
      baseTx(structurer, pick(receiverPool), {
        transaction_type: "CASH_OUT",
        amount,
        channel: "AGENT",
        agent_id: "demo-agent-77",
      })
    );
  }

  while (txs.length < count) {
    const sender = pick(senders);
    txs.push(baseTx(sender, pick(sender.receivers)));
  }

  for (let i = txs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [txs[i], txs[j]] = [txs[j], txs[i]];
  }
  return txs.slice(0, count);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRda() {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  for (;;) {
    try {
      const res = await fetch(`${RDA_URL}/livez`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {}
    if (Date.now() >= deadline) {
      console.error(`RDA is unreachable at ${RDA_URL} — is the stack up? (set RDA_URL to override)`);
      process.exit(1);
    }
    await sleep(2000);
  }
}

async function main() {
  await waitForRda();

  const txs = buildTransactions(TX_COUNT);
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;

  const counts = { sent: 0, accepted: 0, declined: 0, review: 0, errors: 0 };
  const interval = 1000 / RPS;

  console.log(`Sending ${txs.length} transactions to ${RDA_URL}/v1/predict at ~${RPS} rps (run ${RUN_ID})`);

  for (const tx of txs) {
    const started = Date.now();
    tx.timestamp = started;
    counts.sent += 1;
    try {
      const res = await fetch(`${RDA_URL}/v1/predict`, {
        method: "POST",
        headers,
        body: JSON.stringify(tx),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.decision === "ACCEPT") counts.accepted += 1;
        else if (body.decision === "DECLINE") counts.declined += 1;
        else if (body.decision === "REVIEW") counts.review += 1;
      } else {
        counts.errors += 1;
        if (counts.errors <= 5) console.error(`  HTTP ${res.status} for ${tx.transaction_id}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      counts.errors += 1;
      if (counts.errors <= 5) console.error(`  request failed for ${tx.transaction_id}: ${err.message}`);
    }
    if (counts.sent % 100 === 0) console.log(`  ${counts.sent}/${txs.length} sent`);
    const elapsed = Date.now() - started;
    if (elapsed < interval) await sleep(interval - elapsed);
  }

  console.log("\nDemo traffic summary");
  console.log(`  sent:     ${counts.sent}`);
  console.log(`  accepted: ${counts.accepted}`);
  console.log(`  declined: ${counts.declined}`);
  console.log(`  review:   ${counts.review}`);
  console.log(`  errors:   ${counts.errors}`);

  if (counts.errors > counts.sent * 0.1) {
    console.error(`\nMore than 10% of requests errored (${counts.errors}/${counts.sent}).`);
    process.exit(1);
  }
}

main();
