// Mock data for the Sentinel fraud-ops dashboard.
// Used when the live RDA/FIA APIs are unreachable so the design
// can still be reviewed end-to-end against a stable dataset.

export const MOCK = (() => {
  const senders = ['user_acme_42','user_acme_99','tobi_lag_88','funmi_abj_03','nneka_ph_21','obinna_lag_55','zainab_kano_07','seun_ib_14','ada_enu_62','chika_ph_91','fola_abj_30','imran_kad_44','yemi_lag_72','musa_kano_18'];
  const receivers = ['acct_glassmark','acct_helios_food','acct_betatech','acct_mtn_top_up','acct_jumia_pay','acct_dangote_sup','acct_mule_a','acct_p2p_77','ibm_ng_billing','aws_lagos_acct','acct_ride_pay','acct_kuda_top','acct_palmpay_x','acct_chowdeck_pay'];
  const segments = ['high_value','p2p_transfer','checkout_cnp','payouts','utility_topup','marketplace'];
  const txnTypes = ['TRANSFER','PAYMENT','PAYOUT','WITHDRAWAL'];
  const reasons = ['AMOUNT_HIGH','VELOCITY_24H','TIME_SINCE_LAST','PAGERANK','CLUSTERING_COEF','HOUR_OF_DAY','BENEFICIARY_NEW','DEVICE_NEW','IP_VPN','ASN_DENY','KYC_THIN','SMURFING_PATTERN'];

  // deterministic-ish PRNG
  const seed = (s => () => (s = (s * 9301 + 49297) % 233280) / 233280)(11);
  const pick = (arr) => arr[Math.floor(seed() * arr.length)];
  const uuid = (i) => {
    const parts = ['550e8400','a3b1c70d','9f0a3e52','f72e0c19','7c4a82b1','d91e4f08','e041cd9b','2f7b41a0','8b1d2e4f','b14e0c7d','7a1c93b8','51f0ab2e','c0e4f180','3d7a1b50','1d39a52e'];
    return `${parts[i % parts.length]}-${(0x1000 + i*7).toString(16)}-41d4-a716-${(446655440000 + i).toString().padStart(12,'0')}`;
  };
  const now = Date.now();

  // ──────── Review queue ────────
  const queue = Array.from({length: 12}, (_, i) => {
    const ageMin = [312, 278, 167, 142, 82, 58, 41, 28, 23, 15, 9, 3][i];
    const segment = pick(segments);
    const amount = Math.round([250000, 1200000, 84500, 450000, 670000, 38200, 92500, 188000, 21500, 540000, 105000, 1800][i] || (seed() * 950000 + 8000));
    const stage = i === 1 ? 'PRE_RULE' : 'POST_ML';
    const score = stage === 'PRE_RULE' ? null : +(0.45 + seed() * 0.5).toFixed(2);
    const shadow = score === null ? null : +(Math.max(0, Math.min(1, score + (seed() - 0.4) * 0.15))).toFixed(2);
    const used = new Set();
    const codes = [];
    const codeCount = stage === 'PRE_RULE' ? 1 : 2 + Math.floor(seed() * 2);
    for (let k = 0; k < codeCount; k++) {
      let idx; do { idx = Math.floor(seed() * reasons.length); } while (used.has(idx));
      used.add(idx); codes.push(reasons[idx]);
    }
    return {
      auditId: 'aud_' + (90230 + i),
      transactionId: uuid(i),
      sender: pick(senders),
      receiver: pick(receivers),
      amount,
      segment,
      txnType: pick(txnTypes),
      championScore: score,
      shadowScore: shadow,
      threshold: 0.65,
      modelVersion: 'v1.1.0',
      ageMin,
      reasonCodes: codes,
      reasonContribs: codes.map(c => +(0.31 - seed() * 0.18).toFixed(2)),
      finalDecision: 'DECLINE',
      stage,
      preRule: stage === 'PRE_RULE' ? 'blocklist-mules' : null,
      fia: {
        verdict: stage === 'PRE_RULE' || score > 0.8 ? 'FRAUD_CONFIRMED' : (seed() > 0.6 ? 'UNCERTAIN' : 'FRAUD_CONFIRMED'),
        confidence: +(0.5 + seed() * 0.45).toFixed(2),
        narrative: 'Receiver matches mule-cluster pattern; sender 24h velocity 4× baseline. Recommend BLOCK + freeze receiver pending KYC re-verify.'
      },
      similar: ['aud_90187','aud_89944','aud_89812']
    };
  });

  // ──────── Rules ────────
  const rules = [
    {id:'r_vendor_allow', name:'vendor-allowlist-override', stage:'PRE', action:'ALLOW', priority:1, isActive:true, matches7d: 8901, updatedAt:'2026-05-12', expression: {
      'in': [{var:'receiver_id'}, {var:'config.vendor_ids'}]
    }},
    {id:'r_asn_deny', name:'blocklist-mules', stage:'PRE', action:'DENY', priority:5, isActive:true, matches7d: 312, updatedAt:'2026-05-09', expression: {
      'in': [{var:'features.receiver_id'}, ['acct_mule_a','acct_mule_b','acct_mule_c','acct_mule_d','acct_mule_e']]
    }},
    {id:'r_velocity_7d', name:'velocity-24h-spike', stage:'POST', action:'REVIEW', priority:10, isActive:true, matches7d: 1248, updatedAt:'2026-05-11', expression: {
      and: [
        { '>': [{var:'features.amount_24h_sum'}, 500000] },
        { '>': [{var:'features.velocity_zscore'}, 3.0] },
        { '==': [{var:'segment'}, 'p2p_transfer'] }
      ]
    }},
    {id:'r_high_value_new', name:'high-value-new-receiver', stage:'POST', action:'DENY', priority:20, isActive:true, matches7d: 412, updatedAt:'2026-05-09', expression: {
      and: [
        { '>=': [{var:'amount'}, 200000] },
        { '==': [{var:'features.beneficiary_first_send'}, true] },
        { '<': [{var:'features.account_age_days'}, 30] }
      ]
    }},
    {id:'r_ml_borderline', name:'ml-borderline-review', stage:'POST', action:'REVIEW', priority:50, isActive:true, matches7d: 2204, updatedAt:'2026-05-10', expression: {
      and: [
        { '>=': [{var:'ml_score'}, 0.55] },
        { '<': [{var:'ml_score'}, 0.78] }
      ]
    }},
    {id:'r_smurfing', name:'smurfing-detector', stage:'POST', action:'REVIEW', priority:25, isActive:true, matches7d: 89, updatedAt:'2026-05-07', expression: {
      and: [
        { '>=': [{var:'features.txns_1h_count'}, 6] },
        { '<': [{var:'amount'}, 100000] }
      ]
    }},
    {id:'r_crypto_cap', name:'crypto-payout-cap', stage:'POST', action:'DENY', priority:30, isActive:false, matches7d: 0, updatedAt:'2026-03-18', expression: {
      and: [
        { '==': [{var:'segment'}, 'crypto_payouts'] },
        { '>': [{var:'amount'}, 5000000] }
      ]
    }}
  ];

  // ──────── Models ────────
  const models = [
    { version:'v1.2.0', status:'SHADOW', sha256:'b14e…9ac2', sourceUri:'s3://fraud-models/v1.2.0.onnx', defaultThreshold:0.62, F1:0.571, AUC:0.918, precision:0.851, recall:0.438, deployedAt:'2026-05-08', traffic:'shadow' },
    { version:'v1.1.0', status:'ACTIVE', sha256:'a91c…7d4f', sourceUri:'s3://fraud-models/v1.1.0.onnx', defaultThreshold:0.65, F1:0.554, AUC:0.911, precision:0.841, recall:0.414, deployedAt:'2026-04-02', traffic:'100%' },
    { version:'v1.3.0-rc1', status:'CANDIDATE', sha256:'c2e1…b08a', sourceUri:'s3://fraud-models/v1.3.0-rc1.onnx', defaultThreshold:0.65, F1:null, AUC:null, precision:null, recall:null, deployedAt:'2026-05-12', traffic:'—' },
    { version:'v1.0.0', status:'RETIRED', sha256:'3f0a…b18d', sourceUri:'s3://fraud-models/v1.0.0.onnx', defaultThreshold:0.65, F1:0.532, AUC:0.892, precision:0.819, recall:0.395, deployedAt:'2026-01-08', traffic:'—' },
    { version:'v0.9.4', status:'RETIRED', sha256:'77d2…ee01', sourceUri:'s3://fraud-models/v0.9.4.onnx', defaultThreshold:0.68, F1:0.504, AUC:0.871, precision:0.802, recall:0.367, deployedAt:'2025-11-12', traffic:'—' }
  ];

  // 20 buckets x 2 models for distribution
  const champBuckets = [482,1218,1647,1923,2106,1844,1502,1183,894,612,512,388,304,201,167,128,98,76,52,38];
  const shadowBuckets = [421,1097,1543,1885,2070,1933,1631,1248,982,701,604,470,398,288,224,178,142,109,82,61];

  const segmentThresholds = [
    { segment:'high_value', model:'v1.1.0', threshold:0.55, source:'override' },
    { segment:'p2p_transfer', model:'v1.1.0', threshold:0.62, source:'global' },
    { segment:'checkout_cnp', model:'v1.1.0', threshold:0.70, source:'global' },
    { segment:'payouts', model:'v1.1.0', threshold:0.65, source:'global' },
    { segment:'utility_topup', model:'v1.1.0', threshold:0.72, source:'override' }
  ];

  // ──────── Investigation reports ────────
  const verdicts = ['FRAUD_CONFIRMED','UNCERTAIN','LIKELY_LEGITIMATE'];
  const indicatorMap = {
    FRAUD_CONFIRMED: ['Velocity spike','New receiver account','Mule-network proximity','Off-hour transfer','Device fingerprint match','ASN deny-listed','Smurfing pattern','Thin KYC'],
    UNCERTAIN: ['Amount outlier','Verified merchant','Conflicting signals','New device','3DS cleared','VPN exit'],
    LIKELY_LEGITIMATE: ['Recurring B2B','Vendor allowlist','Stable device','High KYC tier','Established receiver','Within baseline']
  };

  const reports = Array.from({length: 9}, (_, i) => {
    const v = ['FRAUD_CONFIRMED','FRAUD_CONFIRMED','UNCERTAIN','FRAUD_CONFIRMED','LIKELY_LEGITIMATE','UNCERTAIN','FRAUD_CONFIRMED','LIKELY_LEGITIMATE','UNCERTAIN'][i];
    const fallback = i === 5;
    const conf = fallback ? 0.40 : +([0.88, 0.74, 0.42, 0.81, 0.91, 0.55, 0.76, 0.84, 0.48][i]);
    const amt = [250000, 84500, 450000, 92500, 14800, 188000, 320000, 26800, 540000][i];
    const turns = fallback ? 0 : [2,0,4,1,0,3,0,2,1][i];
    const indicatorPool = indicatorMap[v];
    const pickedInds = [];
    const used = new Set();
    while (pickedInds.length < 3 + Math.floor(seed()*2)) {
      const idx = Math.floor(seed() * indicatorPool.length);
      if (!used.has(idx)) { used.add(idx); pickedInds.push(indicatorPool[idx]); }
    }
    const narratives = {
      FRAUD_CONFIRMED: [
        "The sender's 24-hour velocity is 4× their 30-day baseline, and the receiver was created two days ago with no prior incoming transfers. Graph analysis places the receiver in a tight cluster with three previously flagged mule accounts. Recommend blocking and freezing the receiver pending KYC re-verification.",
        "Eight transactions in the last hour from this sender, all to first-time receivers in different states. Pattern matches a card-testing or money-laundering smurfing technique. Account opened 11 days ago with minimal KYC tier.",
        "Receiver matches a known mule cluster from case INV-04812. Sender device fingerprint matches a credential-stuffing burst registered on 2026-02-21. Off-hour transfer at 03:17 WAT, well outside sender's baseline activity window."
      ],
      UNCERTAIN: [
        "Amount is 6× the sender's usual monthly spend but the receiver is a verified enterprise merchant with consistent inbound traffic. Either a legitimate quarterly invoice or a compromised account being used to pay attacker-controlled-but-merchant-fronted invoices. Manual customer contact recommended.",
        "New device for this sender but the geo and ISP are consistent with their recent travel pattern. 3DS challenge was cleared on first attempt. Insufficient signal to confirm; recommend reviewer ping the sender via in-app notification.",
        "Mixed signals: high amount outlier and new beneficiary but the sender has 14 months of clean history and the recipient just passed Tier-3 KYC last week. Recommend manual review with customer call."
      ],
      LIKELY_LEGITIMATE: [
        "Recurring B2B disbursement to a verified vendor on the internal allowlist. Pattern matches six prior accepted transactions in the last 90 days for the same sender–receiver pair. No anomalies in device, geo, or velocity.",
        "Utility top-up to known biller account. Sender has 22 prior transactions to the same biller across 8 months. Stable device, sender baseline. No follow-up needed.",
        "Salary disbursement from a verified enterprise payroll account to an employee. Receiver KYC Tier-3, sender on payouts allowlist. Standard recurring payment."
      ]
    };
    return {
      id: 'rep_' + (5800 + i),
      transactionId: uuid(i + 20),
      verdict: v,
      recommendedAction: v === 'FRAUD_CONFIRMED' ? 'BLOCK' : (v === 'UNCERTAIN' ? 'MANUAL_REVIEW' : 'ALLOW'),
      agentConfidence: conf,
      sender: pick(senders),
      receiver: pick(receivers),
      amount: amt,
      txnType: pick(txnTypes),
      llmModelVersion: fallback ? 'phi-3-mini-fallback' : 'phi-3-mini-v1',
      createdAt: new Date(now - (i*3 + 1)*3600000).toISOString(),
      ageLabel: ['12 min ago','27 min ago','1h 22m ago','2h 04m ago','3h 18m ago','4h 41m ago','7h 02m ago','9h 19m ago','11h 47m ago'][i],
      keyIndicators: pickedInds,
      narrative: fallback ? 'Automated fallback report. The LLM service was unavailable during scoring; template generated from rule and feature outputs only.' : (narratives[v][i % 3]),
      turns,
      conversation: turns > 0 ? [
        { role:'user', author:'Ayo A.', at:'2h ago', body:'Did the device match anything in the last 30 days? Compare against AUD-89944.' },
        { role:'agent', at:'2h ago', body:'Yes — fingerprint matches 4 prior cases within 30 days; all 4 were declined and one (AUD-89944) had an override-to-fraud action. Cluster id cluster_2310-vpn-burst.' },
        ...(turns > 2 ? [
          { role:'user', author:'Ayo A.', at:'1h ago', body:'Pull the ASN history for this IP.' },
          { role:'agent', at:'1h ago', body:'ASN AS56789 has 12 declines and 2 confirmed-fraud overrides in the last 14 days. ASN is on the internal shared deny list as of 2026-04-30.' }
        ] : [])
      ] : []
    };
  });

  // ──────── API keys ────────
  const apiKeys = [
    { id:'key_01H', name:'checkout-prod', prefix:'fdk_9c3a8e2f4b1d_', scope:'predict', rateLimit:1200, lastUsed:'2m ago', expires:'31 Dec 2026', status:'active' },
    { id:'key_02H', name:'payouts-prod', prefix:'fdk_2f7b41a0c5e9_', scope:'predict', rateLimit:600, lastUsed:'14m ago', expires:'no expiry', status:'active' },
    { id:'key_03H', name:'reviewer-dashboard', prefix:'fdk_e041cd9b7a2f_', scope:'audit', rateLimit:300, lastUsed:'1h ago', expires:'no expiry', status:'active' },
    { id:'key_04H', name:'analyst-cli', prefix:'fdk_aa19c44bd2e0_', scope:'audit', rateLimit:150, lastUsed:'1d ago', expires:'no expiry', status:'active' },
    { id:'key_05H', name:'staging-test', prefix:'fdk_8b1d2e4f0a7c_', scope:'predict', rateLimit:null, lastUsed:'4d ago', expires:'revoked 9 May', status:'revoked' }
  ];

  // ──────── Webhooks ────────
  const webhooks = [
    { id:'wh_01', url:'https://acme.example.com/fraud-webhook', events:['decision.created','decision.overridden'], successRate:99.4, status:'healthy', secret:'whsec_a4c1…', lastDelivery:{code:200, when:'47s ago', tone:'success'}, maxRetries:6 },
    { id:'wh_02', url:'https://hooks.slack.com/services/T0…/B0…/Xy…', events:['decision.overridden','model.activated'], successRate:100, status:'healthy', secret:'whsec_72b9…', lastDelivery:{code:200, when:'8m ago', tone:'success'}, maxRetries:3 },
    { id:'wh_03', url:'https://case-mgmt.internal.example.com/fraud/inbound', events:['decision.created'], successRate:78.2, status:'failing', secret:'whsec_f10e…', lastDelivery:{code:503, when:'3 retries pending', tone:'danger'}, maxRetries:6 },
    { id:'wh_04', url:'https://ledger.trellis.dev/v1/fraud', events:['decision.created'], successRate:99.9, status:'healthy', secret:'whsec_4af2…', lastDelivery:{code:200, when:'2m ago', tone:'success'}, maxRetries:3 }
  ];

  const deliveries = [
    { status:'DELIVERED', event:'decision.created', host:'acme.example.com', code:200, attempt:'1/6', when:'47s' },
    { status:'PENDING', event:'decision.created', host:'case-mgmt.internal', code:503, attempt:'3/6', when:'2m' },
    { status:'DELIVERED', event:'decision.overridden', host:'hooks.slack.com', code:200, attempt:'1/3', when:'8m' },
    { status:'DELIVERED', event:'decision.created', host:'ledger.trellis.dev', code:200, attempt:'1/3', when:'12m' },
    { status:'FAILED', event:'decision.created', host:'case-mgmt.internal', code:503, attempt:'6/6', when:'14m' },
    { status:'DELIVERED', event:'decision.created', host:'acme.example.com', code:200, attempt:'1/6', when:'18m' },
    { status:'DELIVERED', event:'model.activated', host:'hooks.slack.com', code:200, attempt:'1/3', when:'21m' }
  ];

  return { queue, rules, models, champBuckets, shadowBuckets, segmentThresholds, reports, apiKeys, webhooks, deliveries, reasons };
})();
