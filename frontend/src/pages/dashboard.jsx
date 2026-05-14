// Page 1 — Operator dashboard

import React, { useEffect, useState } from 'react';
import { Ti, PageHead, fmtNaira, fmtAge } from '../components/shell.jsx';
import {
  getStatsToday,
  getStatsWindow,
  listReviewQueue,
} from '../api/client.js';

function Dashboard({ toast, queue, models, reports, webhooks, nav }) {
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
    listReviewQueue()
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
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
  const slaCount = sourceQueue.filter(q => (q.ageMin ?? 0) >= 240).length;
  const oldestAge = sourceQueue.length ? Math.max(...sourceQueue.map(q => q.ageMin ?? 0), 0) : 0;
  // `amount` is a string-numeric from /v1/review-queue (pg numeric) —
  // coerce so the running sum stays numeric rather than concatenating.
  const totalExposure = sourceQueue.reduce((a, b) => a + Number(b.amount ?? 0), 0);

  const accept = stats?.counts?.ACCEPT ?? 0;
  const decline = stats?.counts?.DECLINE ?? 0;
  const review = stats?.counts?.REVIEW ?? 0;
  const total = stats?.total ?? accept + decline + review;

  // p50 / p95 latencies are millisecond-decimal — render to one decimal
  // place to match the original visual density. `—` when the window has
  // no decisions yet.
  const formatLatency = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} ms` : '—';

  // Recent declines — uses the live review queue (when reachable), falling
  // back to whatever the parent passed in (which is itself seeded from MOCK
  // until the API responds). Normalises both shapes.
  const recent = sourceQueue.slice(0, 4).map((q) => {
    const reasonCodes = (q.reasonCodes || []).map((c) =>
      typeof c === 'string' ? c : c?.code || '',
    ).filter(Boolean);
    return {
      id: (q.transactionId || '').slice(0, 8) + '…',
      amount: Number(q.amount ?? 0),
      score: Number(q.championScore ?? 0),
      isRule: q.stage === 'PRE_RULE' || q.decisionSource === 'PRE_RULE',
      rule: q.preRule || q.ruleName || null,
      reasons: reasonCodes.slice(0, 2).join(' · ') || '—',
      age: q.ageMin != null ? fmtAge(q.ageMin) + ' ago' : '',
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
      <PageHead title="Hello, Ayo" sub="Here's what needs your attention today.">
        <button className="icon-only" title="Search"><Ti name="search"/></button>
        <button className="icon-only" title="Notifications" style={{position:'relative'}}>
          <Ti name="bell"/>
          <span style={{position:'absolute', top:6, right:7, width:6, height:6, borderRadius:'50%', background:'var(--color-text-danger)'}}/>
        </button>
      </PageHead>

      {/* Things to do */}
      <section className="panel" style={{marginBottom:14, padding:'16px 18px'}}>
        <div className="panel-head">
          <h2 className="lg">Things to do</h2>
          <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>{todos.length} items</span>
        </div>
        <div style={{display:'flex', flexDirection:'column'}}>
          {todos.map((t, i) => (
            <div key={i} onClick={t.onClick} style={{display:'flex', alignItems:'center', gap:12, padding:'12px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--color-border-tertiary)', cursor:'pointer'}}>
              <div style={{width:34, height:34, borderRadius:8, background: `var(--color-background-${t.tone === 'plain' ? 'secondary' : t.tone})`, color: t.tone === 'plain' ? 'var(--color-text-primary)' : `var(--color-text-${t.tone})`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
                <Ti name={t.icon} size={16}/>
              </div>
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
            <div><span style={{color:'var(--color-text-tertiary)', display:'block'}}>F1</span><span style={{fontWeight:500}}>{champion?.F1 == null ? '—' : champion.F1.toFixed(3)}</span></div>
            <div><span style={{color:'var(--color-text-tertiary)', display:'block'}}>AUC</span><span style={{fontWeight:500}}>{champion?.AUC == null ? '—' : champion.AUC.toFixed(3)}</span></div>
            <div><span style={{color:'var(--color-text-tertiary)', display:'block'}}>p50</span><span style={{fontWeight:500}}>{formatLatency(windowStats?.championLatency?.p50)}</span></div>
            <div><span style={{color:'var(--color-text-tertiary)', display:'block'}}>p95</span><span style={{fontWeight:500}}>{formatLatency(windowStats?.championLatency?.p95)}</span></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Today's decisions</h2>
            <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>{total.toLocaleString()} total</span>
          </div>
          <div style={{display:'flex', height:6, borderRadius:3, overflow:'hidden', marginBottom:10, background:'var(--color-background-secondary)'}}>
            {total > 0 && <div style={{width:`${(accept/total)*100}%`, background:'var(--color-text-success)'}}/>}
            {total > 0 && <div style={{width:`${(decline/total)*100}%`, background:'var(--color-text-danger)'}}/>}
            {total > 0 && <div style={{width:`${(review/total)*100}%`, background:'var(--color-text-warning)'}}/>}
          </div>
          <div style={{display:'flex', justifyContent:'space-between', fontSize:11}}>
            <div><Dot color="var(--color-text-success)"/>Accept<span style={{marginLeft:6, fontWeight:500}}>{accept.toLocaleString()}</span></div>
            <div><Dot color="var(--color-text-danger)"/>Decline<span style={{marginLeft:6, fontWeight:500}}>{decline}</span></div>
            <div><Dot color="var(--color-text-warning)"/>Review<span style={{marginLeft:6, fontWeight:500}}>{review}</span></div>
          </div>
        </section>
      </div>

      {/* Recent declines */}
      <section className="panel">
        <div className="panel-head">
          <h2>Recent declines</h2>
          <a href="#" onClick={e=>{e.preventDefault(); nav('queue');}}>Open review queue<Ti name="chevron-right" size={11} style={{marginLeft:2, verticalAlign:-1}}/></a>
        </div>
        {recent.length === 0 && (
          <p style={{margin:'6px 0 0', fontSize:12, color:'var(--color-text-tertiary)'}}>No recent declines — queue is clear.</p>
        )}
        {recent.map((r, i) => (
          <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderTop: i === 0 ? 'none' : '0.5px solid var(--color-border-tertiary)'}}>
            <code className="mono" style={{fontSize:11, color:'var(--color-text-secondary)', flexShrink:0}}>{r.id}</code>
            <span style={{fontSize:12, fontWeight:500, flexShrink:0}}>{fmtNaira(r.amount)}</span>
            <span className={'pill round danger'} style={{fontSize:11, padding:'1px 7px'}}>{r.isRule ? 'rule' : (typeof r.score === 'number' ? r.score.toFixed(2) : '—')}</span>
            <span className="truncate" style={{fontSize:11, color:'var(--color-text-secondary)'}}>{r.isRule ? `PRE_RULE · ${r.rule || '—'}` : r.reasons}</span>
            <span style={{fontSize:11, color:'var(--color-text-tertiary)', marginLeft:'auto', flexShrink:0, whiteSpace:'nowrap'}}>{r.age}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function Dot({ color }) {
  return <span style={{display:'inline-block', width:6, height:6, borderRadius:'50%', background:color, marginRight:5, verticalAlign:1}}/>;
}

export default Dashboard;
