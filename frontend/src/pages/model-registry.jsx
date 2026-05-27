// Page 6 — Model registry (champion vs shadow w/ distribution)

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead, Modal, statusPill, permLock } from '../components/shell.jsx';
import { listSegmentThresholds, getModelComparison, deleteModel } from '../api/client.js';

function ModelRegistry({ toast, models, setModels, segmentThresholds, setSegmentThresholds, user }) {
  // Hydrate the per-segment thresholds table from /v1/admin/segment-thresholds
  // on mount. The DB is the source of truth — an empty response means
  // "no segment thresholds configured" and we render the empty state
  // rather than papering over it with seed data.
  useEffect(() => {
    let cancelled = false;
    listSegmentThresholds()
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setSegmentThresholds(
          rows.map((r) => ({
            segment: r.segment,
            model: r.modelVersion || r.model,
            threshold: typeof r.threshold === 'number' ? r.threshold : parseFloat(r.threshold) || 0.65,
            source: r.isActive === false ? 'global' : 'override',
          })),
        );
      })
      .catch(() => {
        /* leave the list empty — the UI will show "no thresholds configured" */
      });
    return () => {
      cancelled = true;
    };
  }, [setSegmentThresholds]);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [metaModel, setMetaModel] = useState(null); // version-string or null
  const [thresholdEditor, setThresholdEditor] = useState(null);
  const [shadowMissing, setShadowMissing] = useState(false); // banner toggle for the OnnxService caveat
  const [openMenu, setOpenMenu] = useState(null);
  // `pendingDelete` holds the model row awaiting confirmation in the delete
  // modal; `deleting` tracks the in-flight API call so the confirm button
  // can show a spinner and resist double-clicks.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [bgRefresh, setBgRefresh] = useState(11);
  // Live comparison rollup over the last 24h. `null` while loading;
  // `{ replayed: 0, agreement: null, ... }` when there's no data.
  const [comparison, setComparison] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setBgRefresh(s => s <= 1 ? 60 : s - 1), 1000);
    return () => clearInterval(t);
  }, []);

  const champion = models.find(m => m.status === 'ACTIVE');
  const shadow = models.find(m => m.status === 'SHADOW');

  // Pull the live champion-vs-shadow comparison whenever the labels change.
  useEffect(() => {
    if (!champion?.version || !shadow?.version) {
      setComparison(null);
      return undefined;
    }
    let cancelled = false;
    getModelComparison({ championVersion: champion.version, shadowVersion: shadow.version })
      .then((res) => {
        if (cancelled) return;
        setComparison(res);
      })
      .catch(() => setComparison(null));
    return () => {
      cancelled = true;
    };
  }, [champion?.version, shadow?.version]);

  // Score-distribution buckets come straight from the comparison API.
  // When the response is missing or malformed we render a 20-zero axis
  // (empty histogram) rather than falling back to design-time data.
  const liveChampBuckets = comparison?.scoreBuckets?.champion;
  const liveShadowBuckets = comparison?.scoreBuckets?.shadow;
  const ZERO_BUCKETS = new Array(20).fill(0);
  const champBuckets = Array.isArray(liveChampBuckets) && liveChampBuckets.length === 20 ? liveChampBuckets : ZERO_BUCKETS;
  const shadowBuckets = Array.isArray(liveShadowBuckets) && liveShadowBuckets.length === 20 ? liveShadowBuckets : ZERO_BUCKETS;

  // Stats counts for the four lifecycle tiles
  const counts = useMemo(() => ({
    ACTIVE: models.filter(m => m.status === 'ACTIVE').length,
    SHADOW: models.filter(m => m.status === 'SHADOW').length,
    CANDIDATE: models.filter(m => m.status === 'CANDIDATE').length,
    RETIRED: models.filter(m => m.status === 'RETIRED').length
  }), [models]);

  // Promote gating per spec: F1Δ ≥ 0.01 is enforced client-side. McNemar
  // gating requires ground-truth fraudLabel which most adopters don't
  // carry — `comparison.mcnemarP` is null until that's wired.
  const mcnemarP = comparison?.mcnemarP ?? null;
  const f1Delta = shadow && champion && shadow.F1 != null && champion.F1 != null
    ? +(shadow.F1 - champion.F1).toFixed(3)
    : 0;
  const promoteAllowed = (mcnemarP == null || mcnemarP < 0.05) && f1Delta >= 0.01 && !!shadow;
  const promoteBlocker = !shadow
    ? 'No shadow registered'
    : mcnemarP != null && mcnemarP >= 0.05
    ? 'McNemar p ≥ 0.05'
    : f1Delta < 0.01
    ? 'F1Δ < 0.01'
    : null;

  const doPromote = () => {
    if (!promoteAllowed) return;
    setModels(ms => ms.map(m => {
      if (m.version === shadow.version) return { ...m, status: 'ACTIVE', traffic:'100%' };
      if (m.version === champion.version) return { ...m, status: 'RETIRED', traffic:'—' };
      return m;
    }));
    toast(`Promoted ${shadow.version} · ${champion.version} retired in same transaction`, 'success');
  };

  const setStatus = (version, status) => {
    setModels(ms => ms.map(m => m.version === version ? {...m, status, traffic: status === 'ACTIVE' ? '100%' : (status === 'SHADOW' ? 'shadow' : '—')} : m));
    setOpenMenu(null);
    toast(`${version} → ${status}`);
  };

  // Hard-delete a RETIRED model version. RDA's DELETE returns 409 if the
  // row is still ACTIVE / SHADOW — we surface that as a targeted hint
  // pointing the operator at the status menu rather than echoing the
  // raw error text.
  const doDelete = async (version) => {
    setDeleting(true);
    try {
      await deleteModel(version);
      setModels(ms => ms.filter(m => m.version !== version));
      toast(`Model ${version} deleted`, 'success');
      setPendingDelete(null);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.includes('409')) {
        toast('Cannot delete — retire the model first via the status menu', 'error');
      } else {
        toast(msg, 'error');
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHead crumbs={['Dashboard','Insights']} title="Models" sub={<>Registry refreshes every 30s · last sync <span className="mono">{60 - bgRefresh}s ago</span></>}>
        <button onClick={()=>setShadowMissing(s => !s)} title="Toggle shadow-missing banner"><Ti name="alert-triangle" size={14}/></button>
        <button><Ti name="player-play" size={14}/>Backtest</button>
        <button className="info-bg" onClick={()=>setRegisterOpen(true)} {...permLock(user, 'models:register')}><Ti name="plus" size={14}/>Register version</button>
      </PageHead>

      {/* Lifecycle tiles */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:12}}>
        <LifecycleTile label="ACTIVE" count={counts.ACTIVE} tone="success" sub={champion?.version}/>
        <LifecycleTile label="SHADOW" count={counts.SHADOW} tone="warning" sub={shadow?.version || 'none'}/>
        <LifecycleTile label="CANDIDATE" count={counts.CANDIDATE} sub="awaiting eval"/>
        <LifecycleTile label="RETIRED" count={counts.RETIRED} tone="tertiary" sub="last 90d"/>
      </div>

      {/* Shadow-missing caveat banner */}
      {shadowMissing && (
        <div className="banner warn" style={{marginBottom:12}}>
          <Ti name="alert-triangle" size={14} className="b-icon"/>
          <div>
            <b>Shadow registered but not scoring.</b> No shadowScore values written in the last hour. OnnxService loads one session at a time — extend it to load a second session, or run offline replay only.
            <div style={{marginTop:6, display:'flex', gap:6}}>
              <button style={{padding:'3px 8px', fontSize:11}}>View deploy doc</button>
              <button style={{padding:'3px 8px', fontSize:11}}>Replay offline</button>
            </div>
          </div>
        </div>
      )}

      {/* Champion vs Shadow */}
      <section className="panel" style={{marginBottom:12}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:14, flexWrap:'wrap'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <h2 style={{margin:0, fontSize:14, fontWeight:500, whiteSpace:'nowrap'}}>Champion vs Shadow</h2>
            <span style={{fontSize:10, color:'var(--color-text-tertiary)', whiteSpace:'nowrap'}}>
              replayed 24h · {comparison?.replayed != null ? comparison.replayed.toLocaleString() : '—'} decisions
            </span>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:6}}>
            <button title={promoteAllowed ? '' : (promoteBlocker || '')} className={promoteAllowed ? 'success-bg' : ''} disabled={!promoteAllowed} onClick={doPromote} style={{padding:'6px 12px'}}>
              <Ti name="arrow-up" size={14}/>Promote shadow
            </button>
          </div>
        </div>

        {/* Stats grid */}
        <div className="row-grid header" style={{gridTemplateColumns:'130px repeat(4, 1fr)', marginBottom:0}}>
          <span></span>
          <span>F1</span><span>AUC</span><span>PRECISION</span><span>RECALL</span>
        </div>
        <StatRow color="info" label="Champion" version={champion?.version} F1={champion?.F1} AUC={champion?.AUC} P={champion?.precision} R={champion?.recall}/>
        <StatRow color="warning" label="Shadow" version={shadow?.version} F1={shadow?.F1} AUC={shadow?.AUC} P={shadow?.precision} R={shadow?.recall} compareTo={champion}/>

        {/* Distribution */}
        <div style={{marginTop:14}}>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6}}>
            <p style={{margin:0, fontSize:11, color:'var(--color-text-secondary)'}}>Score distribution</p>
            <div style={{display:'flex', gap:14, fontSize:10, color:'var(--color-text-secondary)'}}>
              <LegendSwatch color="var(--color-text-info)" label="Champion"/>
              <LegendSwatch color="var(--color-text-warning)" label="Shadow"/>
              <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
                <span style={{width:14, height:0, borderTop:'1.5px dashed var(--color-text-danger)', display:'inline-block'}}/>
                <span>threshold</span>
              </span>
            </div>
          </div>
          <Histogram champ={champBuckets} shadow={shadowBuckets} threshold={0.65}/>
        </div>

        {/* Agreement / McNemar / NetΔ — derived from /v1/admin/models/comparison */}
        <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:10, paddingTop:10, borderTop:'0.5px solid var(--color-border-tertiary)'}}>
          <KV
            label="AGREEMENT"
            value={comparison?.agreement == null ? '—' : `${(comparison.agreement * 100).toFixed(1)}%`}
          />
          <KV
            label="MCNEMAR p"
            value={mcnemarP == null ? '—' : mcnemarP < 0.01 ? <span style={{color:'var(--color-text-success)'}}>&lt; 0.01</span> : mcnemarP.toFixed(3)}
            sub={mcnemarP == null ? 'requires fraudLabel ground truth' : `p = ${mcnemarP}`}
          />
          <KV
            label="NET ΔDECLINE"
            value={comparison?.netDeclineDelta == null ? '—' : (comparison.netDeclineDelta > 0 ? '+' : '') + comparison.netDeclineDelta}
            sub={comparison?.netDeclineDelta == null ? '' : comparison.netDeclineDelta > 0 ? 'shadow more strict' : comparison.netDeclineDelta < 0 ? 'shadow more permissive' : 'identical decline rate'}
          />
        </div>
      </section>

      {/* Per-segment thresholds */}
      <section className="panel" style={{marginBottom:12}}>
        <div className="panel-head">
          <div>
            <h2>Per-segment thresholds</h2>
            <p style={{margin:'2px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>Resolution: segment override → model default → <code className="mono">FRAUD_THRESHOLD</code> env</p>
          </div>
          <button style={{fontSize:11, padding:'4px 9px'}}><Ti name="plus" size={12}/>Add</button>
        </div>

        <div className="row-grid header" style={{gridTemplateColumns:'1.4fr 1fr 90px 90px 24px'}}>
          <span>SEGMENT</span><span>MODEL</span><span>THRESHOLD</span><span>SOURCE</span><span></span>
        </div>
        {segmentThresholds.map(st => {
          // Threshold may be a string-numeric from /v1/admin/segment-thresholds —
          // coerce so `.toFixed` doesn't blow up on a non-number.
          const thresholdNum = typeof st.threshold === 'number' ? st.threshold : Number(st.threshold);
          return (
            <div key={st.segment} className="row-grid" style={{gridTemplateColumns:'1.4fr 1fr 90px 90px 24px'}}>
              <span className="mono" style={{fontSize:12}}>{st.segment}</span>
              <span className="mono" style={{fontSize:12, color:'var(--color-text-secondary)'}}>{st.model}</span>
              <span style={{fontSize:12, fontWeight:500}}>{Number.isFinite(thresholdNum) ? thresholdNum.toFixed(2) : '—'}</span>
              <span className={'pill ' + (st.source === 'override' ? 'info' : '')} style={{justifySelf:'start', padding:'1px 6px', fontSize:9}}>{st.source}</span>
              <button className="ghost icon-only" onClick={()=>setThresholdEditor(st)}><Ti name="dots-vertical" size={12}/></button>
            </div>
          );
        })}
      </section>

      {/* Version history */}
      <section className="panel">
        <div className="panel-head"><h2>Version history</h2></div>
        <div className="row-grid header" style={{gridTemplateColumns:'90px 100px 1fr 70px 70px 70px 70px 30px'}}>
          <span>VERSION</span><span>STATUS</span><span>SOURCE</span><span>F1</span><span>AUC</span><span>SHA256</span><span></span><span></span>
        </div>
        {models.map(m => (
          <div key={m.version} className="row-grid" style={{gridTemplateColumns:'90px 100px 1fr 70px 70px 70px 70px 30px'}}>
            <span className="mono" style={{fontSize:11, fontWeight:500, color: m.status === 'RETIRED' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)'}}>{m.version}</span>
            <span style={{justifySelf:'start'}}>{statusPill(m.status)}</span>
            <span className="mono truncate" style={{fontSize:10, color: m.status === 'RETIRED' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)'}}>{m.sourceUri}</span>
            <span style={{fontSize:11, color: m.status === 'RETIRED' ? 'var(--color-text-tertiary)' : 'inherit'}}>{m.F1 == null ? '—' : m.F1.toFixed(3)}</span>
            <span style={{fontSize:11, color: m.status === 'RETIRED' ? 'var(--color-text-tertiary)' : 'inherit'}}>{m.AUC == null ? '—' : m.AUC.toFixed(3)}</span>
            {/* SHA256 is 64 chars and overflows a 70px column; show the
                first 12 with hover-title for the full hash. */}
            <span
              className="mono"
              title={m.sha256 || ''}
              style={{fontSize:10, color:'var(--color-text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}
            >
              {m.sha256 && m.sha256 !== '—' ? `${m.sha256.slice(0, 12)}…` : '—'}
            </span>
            {/* Delete is only meaningful for CANDIDATE / RETIRED rows — */}
            {/* ACTIVE & SHADOW reject the API call with a 409 so we hide */}
            {/* the button entirely on those rather than show a perma-disabled control. */}
            {m.status !== 'ACTIVE' && m.status !== 'SHADOW' ? (
              <button
                onClick={()=>setPendingDelete(m)}
                style={{color:'var(--color-text-danger)', fontSize:11, padding:'2px 8px', justifySelf:'start'}}
                {...permLock(user, 'models:delete')}
              >
                <Ti name="trash" size={12}/>Delete
              </button>
            ) : <span/>}
            <div style={{position:'relative'}}>
              <button className="ghost icon-only" onClick={()=>setOpenMenu(openMenu === m.version ? null : m.version)}>
                <Ti name="dots-vertical" size={12}/>
              </button>
              {openMenu === m.version && (
                <RowMenu
                  status={m.status}
                  onClose={()=>setOpenMenu(null)}
                  onActivate={()=>setStatus(m.version, 'ACTIVE')}
                  onShadow={()=>setStatus(m.version, 'SHADOW')}
                  onRetire={()=>setStatus(m.version, 'RETIRED')}
                  onBacktest={()=>{ setOpenMenu(null); toast(`npm run replay --target ${m.version} --since 24h`); }}
                  onMeta={()=>{ setMetaModel(m.version); setOpenMenu(null); }}
                />
              )}
            </div>
          </div>
        ))}
      </section>

      {registerOpen && <RegisterModelModal onClose={()=>setRegisterOpen(false)} onSave={(v) => { setModels(ms => [{version:v.version, status:'CANDIDATE', sha256:v.sha256||'—', sourceUri:v.sourceUri, defaultThreshold:+v.threshold, F1:null, AUC:null, precision:null, recall:null, deployedAt:'2026-05-13', traffic:'—'}, ...ms]); setRegisterOpen(false); toast(`Registered ${v.version} as CANDIDATE`, 'success'); }}/>}
      {metaModel && <ModelMetaDrawer model={models.find(m => m.version === metaModel)} onClose={()=>setMetaModel(null)}/>}
      {thresholdEditor && <ThresholdEditorModal seg={thresholdEditor} onClose={()=>setThresholdEditor(null)} onSave={(t) => { setSegmentThresholds(arr => arr.map(s => s.segment === thresholdEditor.segment ? {...s, threshold:t, source:'override'} : s)); setThresholdEditor(null); toast(`Threshold updated for ${thresholdEditor.segment}`); }}/>}
      {pendingDelete && (
        <Modal
          title={`Delete model ${pendingDelete.version}?`}
          sub="This action cannot be undone."
          onClose={()=>!deleting && setPendingDelete(null)}
          width={460}
          footer={<>
            <button onClick={()=>setPendingDelete(null)} disabled={deleting}>Cancel</button>
            <button
              className="danger-bg"
              onClick={()=>doDelete(pendingDelete.version)}
              disabled={deleting}
            >
              <Ti name={deleting ? 'loader-2' : 'trash'} size={14}/>
              {deleting ? 'Deleting…' : 'Delete permanently'}
            </button>
          </>}
        >
          <p style={{margin:0, fontSize:12, lineHeight:1.5}}>
            This permanently removes the version row AND its on-disk artefacts in <code className="mono">models/versions/{pendingDelete.version}/</code>. Cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}

// ──────── Sub-components ────────

function LifecycleTile({ label, count, sub, tone }) {
  const color = tone === 'success' ? 'var(--color-text-success)'
    : tone === 'warning' ? 'var(--color-text-warning)'
    : tone === 'tertiary' ? 'var(--color-text-tertiary)'
    : 'var(--color-text-primary)';
  return (
    <div className="tile bordered" style={{padding:'10px 12px'}}>
      <p className="label-up" style={{margin:0}}>{label}</p>
      <p style={{margin:'4px 0 0', fontSize:20, fontWeight:500, color}}>{count}</p>
      <p className="mono" style={{margin:'1px 0 0', fontSize:10, color:'var(--color-text-secondary)'}}>{sub}</p>
    </div>
  );
}

function StatRow({ color, label, version, F1, AUC, P, R, compareTo }) {
  const delta = (val, base) => {
    if (val == null || base == null) return null;
    const d = +(val - base).toFixed(3);
    const sign = d > 0 ? '+' : '';
    return <span style={{fontSize:10, marginLeft:4, color: d > 0 ? 'var(--color-text-success)' : (d < 0 ? 'var(--color-text-danger)' : 'var(--color-text-tertiary)')}}>{sign}{d.toFixed(3)}</span>;
  };
  const tone = color === 'info' ? 'var(--color-text-info)' : 'var(--color-text-warning)';
  return (
    <div className="row-grid" style={{gridTemplateColumns:'130px repeat(4, 1fr)', padding:'var(--row-pad-y, 9px) 0'}}>
      <div style={{display:'flex', alignItems:'center', gap:6}}>
        <span style={{width:8, height:8, borderRadius:2, background: tone, display:'inline-block'}}/>
        <div>
          <p style={{margin:0, fontSize:11, fontWeight:500}}>{label}</p>
          <p style={{margin:0, fontSize:10, color:'var(--color-text-tertiary)', fontFamily:'var(--font-mono)'}}>{version}</p>
        </div>
      </div>
      <span style={{fontSize:13, fontWeight:500}}>{F1 == null ? '—' : F1.toFixed(3)}{compareTo && delta(F1, compareTo.F1)}</span>
      <span style={{fontSize:13, fontWeight:500}}>{AUC == null ? '—' : AUC.toFixed(3)}{compareTo && delta(AUC, compareTo.AUC)}</span>
      <span style={{fontSize:13, fontWeight:500}}>{P == null ? '—' : P.toFixed(3)}{compareTo && delta(P, compareTo.precision)}</span>
      <span style={{fontSize:13, fontWeight:500}}>{R == null ? '—' : R.toFixed(3)}{compareTo && delta(R, compareTo.recall)}</span>
    </div>
  );
}

function Histogram({ champ, shadow, threshold }) {
  // Guard against an undefined / missing bucket prop — the live API can
  // return 20 zeros, the mock can return its own array, but a transient
  // null while loading must not break the spread.
  const champArr = Array.isArray(champ) ? champ : [];
  const shadowArr = Array.isArray(shadow) ? shadow : [];
  const max = Math.max(...champArr, ...shadowArr, 1);
  const W = 720, H = 160;
  const pad = { l: 32, r: 8, t: 12, b: 22 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const bucketCount = champArr.length || 1;
  const bucketSpan = innerW / bucketCount;
  const barW = (bucketSpan - 2) / 2;
  const thresholdX = pad.l + (threshold * innerW);
  const [hover, setHover] = useState(null);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%', height:'auto'}} preserveAspectRatio="none">
      {/* axes */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5"/>
      <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5"/>
      {[0.25, 0.5, 0.75, 1.0].map(g => (
        <line key={g} x1={pad.l} y1={pad.t + innerH - innerH * g} x2={pad.l + innerW} y2={pad.t + innerH - innerH * g} stroke="var(--color-border-tertiary)" strokeWidth="0.5"/>
      ))}

      {/* threshold marker */}
      <line x1={thresholdX} y1={pad.t} x2={thresholdX} y2={pad.t + innerH} stroke="var(--color-text-danger)" strokeWidth="1" strokeDasharray="4,3"/>
      <text x={thresholdX + 4} y={pad.t + 9} fontSize="9" fill="var(--color-text-danger)" fontFamily="var(--font-mono)">0.65</text>

      {/* bars */}
      {champArr.map((v, i) => {
        const x = pad.l + i * bucketSpan + 1;
        const h = (v / max) * innerH;
        const y = pad.t + innerH - h;
        const sv = shadowArr[i] ?? 0;
        const sh = (sv / max) * innerH;
        const sy = pad.t + innerH - sh;
        return (
          <g key={i} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} style={{cursor:'pointer'}}>
            <rect x={x} y={y} width={barW} height={h} fill="var(--color-text-info)" opacity={hover == null || hover === i ? 1 : 0.4}/>
            <rect x={x + barW + 1} y={sy} width={barW} height={sh} fill="var(--color-text-warning)" opacity={hover == null || hover === i ? 1 : 0.4}/>
            {hover === i && (
              <g>
                <rect x={x - 38} y={Math.min(y, sy) - 32} width={94} height={28} rx="3" fill="var(--color-text-primary)"/>
                <text x={x + 9} y={Math.min(y, sy) - 19} fontSize="9" fill="white" fontFamily="var(--font-mono)" textAnchor="middle">{(i/bucketCount).toFixed(2)}–{((i+1)/bucketCount).toFixed(2)}</text>
                <text x={x + 9} y={Math.min(y, sy) - 9} fontSize="9" fill="white" fontFamily="var(--font-mono)" textAnchor="middle">C:{v} · S:{sv}</text>
              </g>
            )}
          </g>
        );
      })}

      {/* x ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <text key={t} x={pad.l + t * innerW} y={H - 8} fontSize="9" fill="var(--color-text-tertiary)" fontFamily="var(--font-mono)" textAnchor="middle">{t.toFixed(2)}</text>
      ))}
      <text x={pad.l + innerW/2} y={H - 0} fontSize="9" fill="var(--color-text-secondary)" textAnchor="middle">fraud probability bucket</text>
    </svg>
  );
}

function KV({ label, value, sub }) {
  return (
    <div>
      <p className="label-up" style={{margin:0}}>{label}</p>
      <p style={{margin:'2px 0 0', fontSize:14, fontWeight:500}}>{value}</p>
      {sub && <p style={{margin:0, fontSize:10, color:'var(--color-text-tertiary)'}}>{sub}</p>}
    </div>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
      <span style={{width:8, height:8, borderRadius:2, background: color}}/>
      {label}
    </span>
  );
}

function RowMenu({ status, onClose, onActivate, onShadow, onRetire, onBacktest, onMeta }) {
  useEffect(() => {
    const close = (_e) => onClose();
    setTimeout(() => window.addEventListener('click', close), 0);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div onClick={e=>e.stopPropagation()} style={{
      position:'absolute', right:0, top:'calc(100% + 4px)', zIndex:20,
      background:'var(--color-background-primary)',
      border:'0.5px solid var(--color-border-tertiary)',
      borderRadius:'var(--border-radius-md)', boxShadow:'var(--shadow-md)',
      minWidth:160, padding:4, fontSize:12
    }}>
      <MenuItem icon="circle-check" disabled={status === 'ACTIVE'} onClick={onActivate}>Activate</MenuItem>
      <MenuItem icon="eye" disabled={status === 'SHADOW'} onClick={onShadow}>Set as shadow</MenuItem>
      <MenuItem icon="archive" disabled={status === 'RETIRED'} onClick={onRetire}>Retire</MenuItem>
      <div style={{height:'0.5px', background:'var(--color-border-tertiary)', margin:'4px 0'}}/>
      <MenuItem icon="player-play" onClick={onBacktest}>Backtest…</MenuItem>
      <MenuItem icon="info-circle" onClick={onMeta}>View metadata</MenuItem>
    </div>
  );
}

function MenuItem({ icon, children, onClick, disabled }) {
  return (
    <div
      onClick={e=>{ e.stopPropagation(); if (!disabled) onClick(); }}
      style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'6px 8px', borderRadius:4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--color-text-quaternary)' : 'var(--color-text-primary)'
      }}
      onMouseEnter={e=>!disabled && (e.currentTarget.style.background = 'var(--color-background-secondary)')}
      onMouseLeave={e=>(e.currentTarget.style.background = 'transparent')}
    >
      <Ti name={icon} size={13}/>
      {children}
    </div>
  );
}

function RegisterModelModal({ onClose, onSave }) {
  const [v, setV] = useState({ version:'v1.4.0-rc1', sourceUri:'s3://fraud-models/v1.4.0-rc1.onnx', sha256:'', threshold:0.65 });
  return (
    <Modal
      title="Register model version"
      sub="Registration is metadata-only. Self-host deploys are still cp models/<file>.onnx ../models/fraud_model.onnx."
      onClose={onClose}
      width={520}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={()=>onSave(v)}>Register as CANDIDATE</button></>}
    >
      <Field label="Version (semver)">
        <input className="mono" value={v.version} onChange={e=>setV({...v, version:e.target.value})}/>
      </Field>
      <Field label="Source URI">
        <input className="mono" value={v.sourceUri} onChange={e=>setV({...v, sourceUri:e.target.value})}/>
      </Field>
      <Field label="SHA-256 (optional)">
        <input className="mono" value={v.sha256} onChange={e=>setV({...v, sha256:e.target.value})} placeholder="recommended"/>
      </Field>
      <Field label="Default threshold">
        <input type="number" step="0.01" min="0" max="1" value={v.threshold} onChange={e=>setV({...v, threshold:e.target.value})}/>
      </Field>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div style={{marginBottom:10}}>
      <label className="label-up" style={{display:'block', marginBottom:4}}>{label}</label>
      {React.cloneElement(children, { style: { width: '100%', ...(children.props.style || {}) } })}
    </div>
  );
}

function ThresholdEditorModal({ seg, onClose, onSave }) {
  const [t, setT] = useState(seg.threshold);
  return (
    <Modal
      title={`Threshold · ${seg.segment}`}
      sub={<>Overrides the model default for this segment. Saved to <code className="mono">segment_thresholds</code> table.</>}
      onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={()=>onSave(+t)}>Save override</button></>}
    >
      <Field label="Threshold">
        <input type="number" step="0.01" min="0" max="1" value={t} onChange={e=>setT(e.target.value)}/>
      </Field>
      <p style={{margin:0, fontSize:11, color:'var(--color-text-secondary)'}}>Resolution: segment-specific → model default → <code className="mono">FRAUD_THRESHOLD</code> env.</p>
    </Modal>
  );
}

function ModelMetaDrawer({ model, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        position:'fixed', top:0, right:0, bottom:0, width:460,
        background:'var(--color-background-primary)',
        borderLeft:'0.5px solid var(--color-border-tertiary)',
        display:'flex', flexDirection:'column',
        animation:'slideIn 0.18s ease-out'
      }}>
        <div style={{padding:'14px 18px', borderBottom:'0.5px solid var(--color-border-tertiary)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10}}>
          <div>
            <h3 style={{margin:0, fontSize:15, fontWeight:500}}>Model metadata</h3>
            <p style={{margin:'4px 0 0', fontSize:12, color:'var(--color-text-secondary)', fontFamily:'var(--font-mono)'}}>{model.version}</p>
          </div>
          <button className="ghost icon-only" onClick={onClose}><Ti name="x" size={14}/></button>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'14px 18px'}}>
          <div style={{display:'grid', gridTemplateColumns:'90px 1fr', rowGap:8, fontSize:12}}>
            <span className="label-up" style={{alignSelf:'center'}}>STATUS</span><span>{statusPill(model.status)}</span>
            <span className="label-up" style={{alignSelf:'center'}}>SHA-256</span><span className="mono" style={{wordBreak:'break-all'}}>{model.sha256}</span>
            <span className="label-up" style={{alignSelf:'center'}}>SOURCE</span><span className="mono" style={{wordBreak:'break-all'}}>{model.sourceUri}</span>
            <span className="label-up" style={{alignSelf:'center'}}>THRESHOLD</span><span>{typeof model.defaultThreshold === 'number' ? model.defaultThreshold.toFixed(2) : '—'}</span>
            <span className="label-up" style={{alignSelf:'center'}}>F1 / AUC</span><span>{model.F1?.toFixed(3) || '—'} / {model.AUC?.toFixed(3) || '—'}</span>
            <span className="label-up" style={{alignSelf:'center'}}>P / R</span><span>{model.precision?.toFixed(3) || '—'} / {model.recall?.toFixed(3) || '—'}</span>
            <span className="label-up" style={{alignSelf:'center'}}>DEPLOYED</span><span>{model.deployedAt}</span>
          </div>
          <h4 style={{margin:'18px 0 8px', fontSize:11, fontWeight:500, color:'var(--color-text-tertiary)', letterSpacing:'0.06em'}}>TRAINING METRICS</h4>
          {/* Real `metrics` + `metadata` from the API row. The previous
              hardcoded "naija-fraud-2026Q1 / adamw / lr 3e-4" sample
              described a neural-net training run — wrong for a stack
              that retrains XGBoost. Empty objects fall back to a hint
              so the drawer isn't blank for cold-start models. */}
          <pre style={{margin:0, padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', fontSize:11, lineHeight:1.6, fontFamily:'var(--font-mono)', overflow:'auto'}}>
            {Object.keys(model.metrics || {}).length === 0 && Object.keys(model.metadata || {}).length === 0
              ? '// No training metrics recorded for this version.\n// MLA writes f1_score / auc_roc / precision / recall when it\n// registers a model via /v1/admin/models.'
              : JSON.stringify({...(model.metrics || {}), ...(model.metadata || {})}, null, 2)}
          </pre>

          <div style={{marginTop:14, padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', fontSize:11, color:'var(--color-text-secondary)'}}>
            <Ti name="terminal" size={12} style={{marginRight:6, verticalAlign:-1}}/>
            <span>Self-host deploy (manual fallback when MLA's RDA bridge isn't wired):</span>
            <pre className="mono" style={{margin:'4px 0 0', fontSize:11, color:'var(--color-text-primary)'}}>cp models/versions/{model.version}/model.onnx models/fraud_model.onnx</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ModelRegistry;
