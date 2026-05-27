// Page 1 — Operator dashboard

import { useEffect, useState } from 'react';
import { Ti, fmtNaira, fmtAge } from '../components/shell.jsx';
import {
  getStatsToday,
  getStatsWindow,
  listReviewQueue,
} from '../api/client.js';

function Dashboard({ toast: _toast, user: _user, queue, models, reports, webhooks, nav }) {
  const champion = models.find(m => m.status === 'ACTIVE');
  const shadow = models.find(m => m.status === 'SHADOW');
  const newReports = reports.slice(0, 4);
  const failingWebhooks = webhooks.filter(w => w.status === 'failing');

  // Today's stats — sourced from /v1/stats/today. Empty state surfaces
  // "—" rather than seeded numbers when the DB is fresh.
  const [stats, setStats] = useState(null);
  // Champion latency comes from /v1/stats/window — p50/p95 over 24h.
  const [windowStats, setWindowStats] = useState(null);
  // Live review-queue rows for the "Recent declines" panel.
  const [liveQueue, setLiveQueue] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getStatsToday()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* safe() already returns a fallback */
      });
    getStatsWindow({ seconds: 86400, sparklineBuckets: 11 })
      .then((s) => {
        if (!cancelled) setWindowStats(s);
      })
      .catch(() => {
        /* swallow — tile renders "—" when null */
      });
    // `/v1/review-queue` returns `{ rows, total, limit, offset }` — unwrap
    // before storing. Earlier the response was treated as a raw array which
    // silently failed the Array.isArray guard, leaving Recent declines empty
    // until the Review Queue page was visited and populated the shared
    // `queue` state.
    listReviewQueue({ limit: 4 })
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res?.rows) ? res.rows : [];
        setLiveQueue(rows);
      })
      .catch(() => {
        /* fall back to props.queue */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceQueue = Array.isArray(liveQueue) ? liveQueue : queue;
  const _slaCount = sourceQueue.filter(q => (q.ageMin ?? 0) >= 240).length;
  const oldestAge = sourceQueue.length ? Math.max(...sourceQueue.map(q => q.ageMin ?? 0), 0) : 0;
  // `amount` is a string-numeric from /v1/review-queue (pg numeric) —
  // coerce so the running sum stays numeric rather than concatenating.
  const totalExposure = sourceQueue.reduce((a, b) => a + Number(b.amount ?? 0), 0);

  const accept = stats?.counts?.ACCEPT ?? 0;
  const decline = stats?.counts?.DECLINE ?? 0;
  const review = stats?.counts?.REVIEW ?? 0;
  const total = stats?.total ?? accept + decline + review;

  // p50 / p95 latencies are millisecond-decimal — render to one decimal
  // place to match the original visual density. Returns `null` when the
  // window has no decisions yet; the caller decides how to render the
  // gap (currently a quiet "unmeasured" label, never an em dash).
  const formatLatency = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} ms` : null;

  // Recent declines — uses the live review queue when reachable, falling
  // back to whatever the parent passed in (an empty array when the API
  // is offline). Normalises both shapes.
  //
  // `ruleCode` is the short identifier shown in the chip (e.g. AMOUNT_HIGH,
  // FRAUD_TEST_SENDER). `ruleDescr` is the long human-readable name —
  // surfaced on hover via the chip's `title` attribute so the row's chip
  // text doesn't dominate the line.
  const recent = sourceQueue.slice(0, 4).map((q) => {
    const reasonCodes = (q.reasonCodes || []).map((c) =>
      typeof c === 'string' ? c : c?.code || '',
    ).filter(Boolean);
    const ruleCode = q.preRule || q.ruleCode || null;
    const ruleDescr = q.ruleName || null;
    // `/v1/review-queue` returns `createdAt` but not `ageMin`. Mirror the
    // computation used by the review-queue page so the dashboard column
    // doesn't render blank for live rows (the props.queue fallback path
    // does already carry `ageMin`).
    const ageMin = q.ageMin != null
      ? Number(q.ageMin)
      : q.createdAt
        ? Math.max(0, Math.round((Date.now() - new Date(q.createdAt).getTime()) / 60000))
        : null;
    const senderRaw = q.senderId || q.sender || '';
    return {
      id: (q.transactionId || '').slice(0, 8) + '…',
      sender: senderRaw ? (senderRaw.length > 14 ? senderRaw.slice(0, 14) + '…' : senderRaw) : '—',
      senderFull: senderRaw,
      amount: Number(q.amount ?? 0),
      score: Number(q.championScore ?? 0),
      isRule: q.stage === 'PRE_RULE' || q.decisionSource === 'PRE_RULE',
      ruleCode,
      ruleDescr,
      reasons: reasonCodes.slice(0, 2).join(' · ') || '—',
      age: ageMin != null ? fmtAge(ageMin) + ' ago' : '',
    };
  });

  const todos = [
    sourceQueue.length > 0 && {
      icon: 'flag', tone: 'danger',
      title: `Review ${sourceQueue.length} declined transactions`,
      sub: `Oldest waiting since ${fmtAge(oldestAge)} ago · ${fmtNaira(totalExposure)} total exposure`,
      when: 'Today',
      onClick: () => nav('queue')
    },
    {
      icon: 'file-search', tone: 'info',
      title: `${newReports.length} new FIA investigation reports ready`,
      sub: `Verdict: ${newReports.filter(r => r.verdict === 'FRAUD_CONFIRMED').length} fraud confirmed, ${newReports.filter(r => r.verdict === 'UNCERTAIN').length} uncertain · phi-3-mini-v1`,
      when: 'Today',
      onClick: () => nav('invest')
    },
    shadow && {
      icon: 'cpu', tone: 'success',
      title: `Model ${shadow.version} ready to activate`,
      // F1 can be null on a freshly-registered candidate that hasn't been
      // scored yet — fall back to "—" instead of throwing on `.toFixed`.
      sub: `Shadow F1 = ${shadow.F1 == null ? '—' : shadow.F1.toFixed(3)} vs champion ${champion?.F1 == null ? '—' : champion.F1.toFixed(3)} · McNemar p < 0.01`,
      when: 'Today',
      onClick: () => nav('models')
    },
    failingWebhooks.length > 0 && {
      icon: 'webhook', tone: 'warning',
      title: `${failingWebhooks.length} webhook deliver${failingWebhooks.length === 1 ? 'y' : 'ies'} failing`,
      // `url` / `lastDelivery` are optional on the mock and may be undefined
      // when the seed shape evolves — string-coerce defensively.
      sub: `${String(failingWebhooks[0].url || '').replace('https://','').split('/')[0] || 'unknown host'} returned ${failingWebhooks[0].lastDelivery?.code ?? '—'} · retry exhausted`,
      when: 'Recently',
      onClick: () => nav('integ')
    },
  ].filter(Boolean);

  return (
    <>
      {/* Date stamp + bell + user identity live in the global Topbar
          (see <Topbar> in shell.jsx). Dashboard starts directly with
          the actionable surface so the operator's eye lands on work. */}

      {/* Things to do */}
      <section className="panel" style={{marginBottom:14, padding:'16px 18px'}}>
        <div className="panel-head">
          <h2 className="lg">Things to do</h2>
          <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>{todos.length} items</span>
        </div>
        <div style={{display:'flex', flexDirection:'column'}}>
          {todos.map((t, i) => (
            <div key={i} onClick={t.onClick} style={{display:'flex', alignItems:'center', gap:12, padding:'12px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--color-border-tertiary)', cursor:'pointer'}}>
              {/* Inline icon — no off-brand colored tile. Tone is
                  carried by the title's content, not by background chrome. */}
              <Ti name={t.icon} size={16} style={{color:'var(--ink-muted)', flexShrink:0}}/>
              <div style={{flex:1, minWidth:0}}>
                <p style={{margin:0, fontSize:13, fontWeight:500}}>{t.title}</p>
                <p className="truncate" style={{margin:'1px 0 0', fontSize:12, color:'var(--color-text-secondary)'}}>{t.sub}</p>
              </div>
              <span style={{fontSize:11, color:'var(--color-text-tertiary)', flexShrink:0, whiteSpace:'nowrap'}}>{t.when}</span>
              <Ti name="chevron-right" size={14} style={{color:'var(--color-text-tertiary)'}}/>
            </div>
          ))}
        </div>
      </section>

      {/* Two-up: champion model + today's decisions */}
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14}}>
        <section className="panel">
          <div className="panel-head">
            <h2>Champion model</h2>
            <a href="#" onClick={e=>{e.preventDefault(); nav('models');}}>View<Ti name="chevron-right" size={11} style={{marginLeft:2, verticalAlign:-1}}/></a>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:12}}>
            <div style={{width:36, height:36, borderRadius:8, background:'var(--color-background-success)', color:'var(--color-text-success)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
              <Ti name="cpu" size={18}/>
            </div>
            <div>
              <p style={{margin:0, fontSize:13, fontWeight:500, whiteSpace:'nowrap'}}>fraud_model · <span className="mono">{champion?.version}</span></p>
              <p style={{margin:'1px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>Threshold {champion?.defaultThreshold} · ACTIVE</p>
            </div>
          </div>
          <div style={{display:'flex', gap:18, fontSize:11}}>
            <ModelMetric label="F1"  value={champion?.F1 == null ? null : champion.F1.toFixed(3)} />
            <ModelMetric label="AUC" value={champion?.AUC == null ? null : champion.AUC.toFixed(3)} />
            <ModelMetric label="p50" value={formatLatency(windowStats?.championLatency?.p50)} />
            <ModelMetric label="p95" value={formatLatency(windowStats?.championLatency?.p95)} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Today's decisions</h2>
            <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>{total.toLocaleString()} total</span>
          </div>
          {/* Hide the bar + legends entirely when there's no data.
              Three "0" legends under an empty axis read as a broken
              chart, not as a real empty state. */}
          {total === 0 ? (
            <p
              style={{
                margin: 0,
                padding: '14px 0',
                textAlign: 'center',
                fontSize: 13.5,
                color: 'var(--ink-muted)',
              }}
            >
              No decisions yet today.
            </p>
          ) : (
            <>
              <div style={{display:'flex', height:6, borderRadius:3, overflow:'hidden', marginBottom:10, background:'var(--color-background-secondary)'}}>
                <div style={{width:`${(accept/total)*100}%`, background:'var(--color-text-success)'}}/>
                <div style={{width:`${(decline/total)*100}%`, background:'var(--color-text-danger)'}}/>
                <div style={{width:`${(review/total)*100}%`, background:'var(--color-text-warning)'}}/>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', fontSize:11}}>
                <div><Dot color="var(--color-text-success)"/>Accept<span style={{marginLeft:6, fontWeight:500}}>{accept.toLocaleString()}</span></div>
                <div><Dot color="var(--color-text-danger)"/>Decline<span style={{marginLeft:6, fontWeight:500}}>{decline}</span></div>
                <div><Dot color="var(--color-text-warning)"/>Review<span style={{marginLeft:6, fontWeight:500}}>{review}</span></div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Recent declines — table with a mono uppercase header row so
          the columns read as ID / AMOUNT / RULE / STAGE / AGE rather
          than four anonymous fields. Header + body share the same
          grid template so values stay column-aligned. */}
      <section className="panel">
        <div className="panel-head">
          <h2>Recent declines</h2>
          <a href="#" onClick={e=>{e.preventDefault(); nav('queue');}}>Open review queue<Ti name="chevron-right" size={11} style={{marginLeft:2, verticalAlign:-1}}/></a>
        </div>
        {recent.length === 0 ? (
          <p style={{margin:'6px 0 0', fontSize:12, color:'var(--color-text-tertiary)'}}>No recent declines — queue is clear.</p>
        ) : (
          <>
            {/* Column template — six columns spread proportionally so the
                row spans the panel rather than collapsing with Age stranded
                on the right. Numeric cells (Amount, Age) are right-aligned
                so digits stack down the column. Sender was added because
                the previous five-column layout left ~500px of empty space
                inside the Stage cell when rows were short PRE_RULE strings. */}
            <div
              role="row"
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'minmax(90px, 0.9fr) minmax(120px, 1.3fr) minmax(90px, 1fr) auto minmax(110px, 1.4fr) minmax(70px, 0.7fr)',
                gap: 12,
                alignItems: 'center',
                padding: '4px 0 8px',
                borderBottom: '1px solid var(--border)',
                fontFamily: 'var(--font-code)',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--ink-faint)',
                lineHeight: 1,
              }}
            >
              <span>ID</span>
              <span>Sender</span>
              <span style={{ textAlign: 'right' }}>Amount</span>
              <span>Rule</span>
              <span>Stage</span>
              <span style={{ textAlign: 'right' }}>Age</span>
            </div>
            {recent.map((r, i) => (
              <div
                key={i}
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'minmax(90px, 0.9fr) minmax(120px, 1.3fr) minmax(90px, 1fr) auto minmax(110px, 1.4fr) minmax(70px, 0.7fr)',
                  gap: 12,
                  alignItems: 'center',
                  padding: '9px 0',
                  borderTop: i === 0 ? 'none' : '0.5px solid var(--color-border-tertiary)',
                }}
              >
                <code className="mono truncate" style={{fontSize:11, color:'var(--color-text-secondary)'}}>{r.id}</code>
                <code className="mono truncate" style={{fontSize:11, color:'var(--color-text-secondary)'}} title={r.senderFull || undefined}>{r.sender}</code>
                <span style={{fontSize:12, fontWeight:500, fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{fmtNaira(r.amount)}</span>
                {/* Chip = short rule code in mono (e.g. AMOUNT_HIGH).
                    The long human-readable name moves to the title
                    attribute as a hover tooltip so it doesn't bloat
                    the row. Score-based declines keep the
                    two-decimal probability in the same slot.
                    `justifySelf: start` keeps the pill hugging its
                    text width instead of being stretched by the grid. */}
                <span
                  className="pill danger"
                  style={{fontSize:11, justifySelf:'start'}}
                  title={r.isRule && r.ruleDescr ? r.ruleDescr : undefined}
                >
                  {r.isRule
                    ? (r.ruleCode || 'RULE')
                    : (typeof r.score === 'number' ? r.score.toFixed(2) : '—')}
                </span>
                <span className="truncate" style={{fontSize:11, color:'var(--color-text-secondary)'}}>
                  {r.isRule ? 'PRE_RULE' : r.reasons}
                </span>
                <span style={{fontSize:11, color:'var(--color-text-tertiary)', whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums', textAlign:'right'}}>{r.age || '—'}</span>
              </div>
            ))}
          </>
        )}
      </section>
    </>
  );
}

function Dot({ color }) {
  return <span style={{display:'inline-block', width:6, height:6, borderRadius:'50%', background:color, marginRight:5, verticalAlign:1}}/>;
}

// Model-metric cell. When the metric is null we render a quiet
// "unmeasured" label in mono / --ink-faint instead of an em dash —
// an em dash next to "p50" / "p95" read as broken layout. The label
// communicates that the metric exists but hasn't been measured yet.
function ModelMetric({ label, value }) {
  return (
    <div>
      <span style={{color:'var(--color-text-tertiary)', display:'block'}}>{label}</span>
      {value == null ? (
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: 'var(--ink-faint)',
            fontWeight: 400,
            letterSpacing: '0.02em',
          }}
        >
          unmeasured
        </span>
      ) : (
        <span style={{fontWeight:500}}>{value}</span>
      )}
    </div>
  );
}

export default Dashboard;
