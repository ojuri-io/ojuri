// Page 3 — Transaction detail
//
// Fetches the audit row by transaction id via `GET /v1/decisions/:id`. When
// the API is unreachable we degrade to the in-memory queue (or the first
// row, as a last resort) so the design still demos. The Confirm /
// Release buttons hit `POST /v1/decisions/:auditId/override`.

import { useState, useEffect } from 'react';
import { Ti, fmtNaira, truncId, displayName } from '../components/shell.jsx';
import {
  getDecision,
  overrideDecision,
  requestReport as apiRequestReport,
  postReportMessage,
} from '../api/client.js';

function TransactionDetail({ toast, user, nav, txn, queue, reports: _reports, refreshQueueCount }) {
  // Live row from the API (when reachable). When null we fall back to the
  // matching `queue` entry — but never to a random queue[0], that gave us
  // a wrong-row "detail" plus a render-time TypeError when the queue is
  // empty in strict-live mode.
  const [live, setLive] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const fromQueue = queue.find((q) => q.transactionId === txn);
  const t = live || fromQueue || null;

  // Hooks must always run unconditionally — declare them BEFORE any
  // early return so React's hook order stays stable across renders.
  const [action, setAction] = useState('confirm');
  const [reason, setReason] = useState('');
  const [followups, setFollowups] = useState([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!txn) return undefined;
    setLoadError(null);
    getDecision(txn)
      .then((row) => {
        if (cancelled) return;
        if (!row) {
          setLoadError('not_found');
          return;
        }
        setLive(normaliseDetail(row, fromQueue));
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = String(err?.message || err);
        // 404s are a real "no such transaction" — surface a friendly empty
        // state. Other errors fall through to the queue copy if one exists.
        if (msg.includes('404')) setLoadError('not_found');
        else if (!fromQueue) setLoadError(msg);
      });
    return () => {
      cancelled = true;
    };
    // `fromQueue` is the snapshot of the row at the moment we navigated
    // in. Including it would re-fetch every time the queue list itself
    // ticks, which defeats the cache-vs-network split.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn]);

  // Loading + empty states — never render the detail body with no `t`.
  if (!t) {
    if (loadError === 'not_found') {
      return (
        <div className="panel" style={{ padding: 60, textAlign: 'center' }}>
          <Ti name="search-off" size={28} style={{ color: 'var(--color-text-tertiary)' }} />
          <h3 style={{ margin: '8px 0 4px', fontSize: 15, fontWeight: 500 }}>
            Transaction not found
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <code className="mono">{txn}</code> has no audit row in the database.
          </p>
          <button onClick={() => nav('tx')}>
            <Ti name="arrow-narrow-left" size={14} /> Back to Transactions
          </button>
        </div>
      );
    }
    if (loadError) {
      return (
        <div className="panel" style={{ padding: 60, textAlign: 'center' }}>
          <Ti name="alert-triangle" size={28} style={{ color: 'var(--color-text-danger)' }} />
          <h3 style={{ margin: '8px 0 4px', fontSize: 15, fontWeight: 500 }}>
            Couldn't load transaction
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {loadError}
          </p>
          <button onClick={() => nav('tx')}>Back</button>
        </div>
      );
    }
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        Loading transaction…
      </div>
    );
  }

  const isPreRule = t.stage === 'PRE_RULE';
  // Did the FIA service actually return a narrative for this transaction?
  // We treat the synthetic queue fallback (verdict UNCERTAIN, narrative '')
  // as "no report" so the user gets a Request button rather than ghost text.
  const hasFiaReport = !!(t.fia && t.fia.narrative);

  // Real reason contributions. The API row carries them as
  //   [{ code, value, contribution, description }, …]
  // — sign of `contribution` decides tone. Falls back to an empty list
  // when the row didn't carry any (defaulted features path).
  const reasonContribs = (t.reasonCodes || []).slice(0, 4).map((r) => {
    if (typeof r === 'string') return { code: r, weight: 0, tone: 'danger' };
    const w = typeof r.contribution === 'number' ? r.contribution : 0;
    return {
      code: r.code,
      weight: w,
      tone: w > 0 ? 'danger' : w < 0 ? 'success' : 'sec',
    };
  });
  const maxAbs = Math.max(...reasonContribs.map((r) => Math.abs(r.weight)), 0.01);

  const send = async () => {
    if (!draft.trim()) return;
    const text = draft;
    setFollowups((f) => [...f, { role: 'user', author: displayName(user), body: text }]);
    setDraft('');
    setThinking(true);
    try {
      // Resolve the FIA report id from the merged audit row. Without a
      // generated report there's nowhere to post a follow-up to — surface
      // the issue instead of faking an answer.
      const reportId = t.fia?.id || t.fia?.reportId;
      if (!reportId) {
        throw new Error('No FIA report — request one first.');
      }
      const res = await postReportMessage(reportId, text);
      setFollowups((f) => [
        ...f,
        {
          role: 'agent',
          body: res?.body || res?.response || '(FIA returned no body)',
          latency: res?.latencyMs ? `${(res.latencyMs / 1000).toFixed(1)}s · ${res?.llmModelVersion || 'phi-3'}` : null,
        },
      ]);
    } catch (err) {
      setFollowups((f) => [
        ...f,
        { role: 'agent', body: `Follow-up failed · ${String(err.message || err)}` },
      ]);
    } finally {
      setThinking(false);
    }
  };

  const requestReport = async () => {
    try {
      const res = await apiRequestReport(t.transactionId);
      // Hard-refresh the merged detail; easier than splicing a fia field.
      const next = {
        ...t,
        fia: {
          id: res.id,
          verdict: res.verdict,
          confidence: res.agentConfidence,
          narrative: res.narrative,
        },
      };
      setLive(next);
      toast('FIA report generated', 'success');
    } catch (err) {
      toast(`FIA unreachable · ${String(err.message || err)}`, 'danger');
    }
  };

  const submit = async () => {
    const isConfirm = action === 'confirm';
    try {
      await overrideDecision(t.auditId, {
        decision: isConfirm ? 'DECLINE' : 'ACCEPT',
        reason,
        fraudLabel: isConfirm,
      });
      toast(
        isConfirm
          ? `Confirmed fraud · ${t.auditId} · MLA gets new label`
          : `Released · ${t.auditId} · decision.overridden fired`,
        isConfirm ? 'danger' : 'success',
      );
      // Tell the parent to refetch the sidebar/header count so the
      // change is visible even from this page (which doesn't own the
      // review-queue state).
      if (typeof refreshQueueCount === 'function') refreshQueueCount();
      setTimeout(() => nav('tx'), 800);
    } catch (err) {
      const m = String(err?.message || err);
      toast(`Override failed · ${m}`, 'danger');
    }
  };

  return (
    <>
      {/* Top breadcrumb + actions */}
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:14}}>
        <div style={{display:'flex', alignItems:'center', gap:10, minWidth:0}}>
          <button className="icon-only" onClick={()=>nav('tx')} aria-label="Back"><Ti name="arrow-narrow-left" size={16}/></button>
          <p className="truncate" style={{margin:0, fontSize:11, color:'var(--color-text-tertiary)'}}>
            Transactions <span style={{padding:'0 4px'}}>›</span> <span className="mono">{truncId(t.transactionId || '', 16)}</span>
          </p>
        </div>
        <div style={{display:'flex', gap:6, flexShrink:0}}>
          <button onClick={()=>document.getElementById('followup-input')?.focus()}><Ti name="message-circle" size={14}/>Ask FIA</button>
          <button onClick={()=>setAction('release')}>Override</button>
          <button className="danger-bg" onClick={()=>setAction('confirm')}>Mark fraudulent</button>
        </div>
      </div>

      {/* Hero */}
      <section className="panel" style={{marginBottom:12, padding:'16px 18px'}}>
        <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, marginBottom:14}}>
          <div style={{minWidth:0}}>
            <p style={{margin:0, fontFamily:'var(--font-mono)', fontSize:12, color:'var(--color-text-secondary)'}}>{t.transactionId}</p>
            <p style={{margin:'6px 0 0', fontSize:24, fontWeight:500}}>{fmtNaira(t.amount)}</p>
            <p style={{margin:'2px 0 0', fontSize:12, color:'var(--color-text-secondary)'}}>
              {t.txnType || 'TRANSFER'}
              {t.createdAt && (
                <> · {new Date(t.createdAt).toLocaleString()}</>
              )}
              {t.segment && t.segment !== '—' && (
                <> · <span style={{whiteSpace:'nowrap'}}>segment <span className="mono" style={{color:'var(--color-text-primary)'}}>{t.segment}</span></span></>
              )}
            </p>
          </div>
          <DecisionPill decision={t.finalDecision} source={t.decisionSource} stage={t.stage}/>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 28px 1fr', gap:12, alignItems:'center', padding:12, background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)'}}>
          <PartyChip role="Sender" handle={t.sender} account={t.context?.customerAccountName}/>
          <Ti name="arrow-right" size={16} style={{color:'var(--color-text-tertiary)', justifySelf:'center'}}/>
          <PartyChip role="Receiver" handle={t.receiver} account={t.context?.beneficiaryAccountName}/>
        </div>
      </section>

      {/* ML decision */}
      {!isPreRule && (
        <section className="panel" style={{marginBottom:12, padding:'16px 18px'}}>
          <div className="panel-head">
            <h2>ML decision</h2>
            <span style={{fontSize:11, color:'var(--color-text-tertiary)', fontFamily:'var(--font-mono)'}}>fraud_model · {t.modelVersion}</span>
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:10, marginBottom:14}}>
            <Tile label="PROBABILITY" value={t.championScore.toFixed(2)} tone="danger"/>
            <Tile label="THRESHOLD" value={t.threshold.toFixed(2)}/>
            <Tile label="LATENCY" value={t.latencyMs == null ? '—' : `${t.latencyMs} ms`}/>
          </div>
          <p style={{margin:'0 0 8px', fontSize:11, color:'var(--color-text-secondary)'}}>Top reason codes</p>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {reasonContribs.map((r, i) => (
              <div key={i} style={{display:'grid', gridTemplateColumns:'140px 1fr 50px', gap:10, alignItems:'center'}}>
                <span style={{fontSize:11, fontFamily:'var(--font-mono)'}}>{r.code}</span>
                <div style={{height:5, background:'var(--color-background-secondary)', borderRadius:3, overflow:'hidden'}}>
                  <div style={{height:'100%', width: `${Math.max(8, (Math.abs(r.weight) / maxAbs) * 100)}%`, background: `var(--color-text-${r.tone})`}}/>
                </div>
                <span style={{fontSize:11, textAlign:'right', color: `var(--color-text-${r.tone})`, fontWeight:500}}>{r.weight > 0 ? '+' : '−'}{Math.abs(r.weight).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Transaction context — populated from the `transactions` JOIN on
          the audit lookup. Sits below ML decision and is collapsed by
          default; operators expand only when they need to inspect the
          payload (channel, geography, narration, …). PAA writes the
          underlying row asynchronously so for very fresh predictions
          `context` is null and the panel shows a "still gathering"
          skeleton instead of dashes. */}
      <TransactionContext context={t.context}/>

      {/* FIA report */}
      <section className="panel" style={{marginBottom:12, padding:'16px 18px'}}>
        <div className="panel-head">
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <div style={{width:24, height:24, borderRadius:6, background:'var(--color-background-info)', color:'var(--color-text-info)', display:'flex', alignItems:'center', justifyContent:'center'}}>
              <Ti name="file-search" size={14}/>
            </div>
            <h2>FIA investigation report</h2>
          </div>
          {hasFiaReport && (
            <span style={{fontSize:10, color:'var(--color-text-tertiary)', fontFamily:'var(--font-mono)'}}>{t.fia.llmModelVersion || 'phi-3-mini'}</span>
          )}
        </div>
        {hasFiaReport ? (
          <>
            <div style={{display:'flex', gap:8, marginBottom:10, flexWrap:'wrap'}}>
              {t.fia.verdict && <span className={'pill ' + (t.fia.verdict === 'FRAUD_CONFIRMED' ? 'danger' : t.fia.verdict === 'LIKELY_LEGITIMATE' ? 'success' : 'warn')} style={{padding:'3px 8px'}}>{t.fia.verdict}</span>}
              {t.fia.recommendedAction && <span className="pill" style={{padding:'3px 8px'}}>Recommended: {t.fia.recommendedAction}</span>}
              {typeof t.fia.confidence === 'number' && <span className="pill" style={{padding:'3px 8px'}}>Confidence {t.fia.confidence.toFixed ? t.fia.confidence.toFixed(2) : t.fia.confidence}</span>}
            </div>
            <p style={{margin:'0 0 10px', fontSize:13, lineHeight:1.6, color:'var(--color-text-primary)'}}>{t.fia.narrative}</p>
            {Array.isArray(t.fia.keyIndicators) && t.fia.keyIndicators.length > 0 && (
              <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                {t.fia.keyIndicators.map(k => (
                  <span key={k} style={{fontSize:10, background:'var(--color-background-secondary)', color:'var(--color-text-secondary)', padding:'3px 8px', borderRadius:10, whiteSpace:'nowrap'}}>{k}</span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{padding:'16px 0', display:'flex', flexDirection:'column', gap:10, alignItems:'flex-start'}}>
            <p style={{margin:0, fontSize:12, color:'var(--color-text-secondary)'}}>No investigation report yet — request one to generate.</p>
            <button className="info-bg" onClick={requestReport}><Ti name="play" size={12}/>Request FIA report</button>
          </div>
        )}
      </section>

      {/* Follow-up thread */}
      <section className="panel" style={{marginBottom:12, padding:'16px 18px'}}>
        <h2 style={{margin:'0 0 12px', fontSize:14, fontWeight:500}}>Follow-up</h2>
        <div style={{display:'flex', flexDirection:'column', gap:10, marginBottom:12}}>
          {followups.map((m, i) => (
            <FollowupRow key={i} m={m}/>
          ))}
          {thinking && (
            <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
              <div style={{width:26, height:26, borderRadius:6, background:'var(--color-background-info)', color:'var(--color-text-info)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
                <Ti name="robot" size={14}/>
              </div>
              <div style={{flex:1, padding:'8px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', fontSize:12, color:'var(--color-text-tertiary)'}}>
                FIA is thinking…
              </div>
            </div>
          )}
        </div>
        <div style={{display:'flex', gap:6, alignItems:'center'}}>
          <input id="followup-input" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==='Enter' && send()} placeholder="Ask a follow-up question…" style={{flex:1}}/>
          <button onClick={send} style={{height:32, padding:'0 12px'}}><Ti name="send" size={14}/>Send</button>
        </div>
      </section>

      {/* Reviewer action */}
      <section className="panel" style={{padding:'16px 18px'}}>
        <h2 style={{margin:'0 0 4px', fontSize:14, fontWeight:500}}>Reviewer action</h2>
        <p style={{margin:'0 0 12px', fontSize:11, color:'var(--color-text-secondary)'}}>Recorded in <code className="mono">decisionAuditLog</code>. Fires the <code className="mono">decision.overridden</code> webhook.</p>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12}}>
          <ActionCard
            checked={action === 'confirm'}
            onClick={()=>setAction('confirm')}
            tone="danger"
            title="Confirm fraud"
            sub={<>Keep DECLINE, set <code className="mono">fraudLabel = true</code>. Feeds MLA training.</>}
          />
          <ActionCard
            checked={action === 'release'}
            onClick={()=>setAction('release')}
            tone="success"
            title="Override to accept"
            sub="Release the transaction. Customer verified out-of-band."
          />
        </div>
        <div style={{marginBottom:12}}>
          <label className="label-up" style={{display:'block', marginBottom:5}}>Reason</label>
          <textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2} placeholder="Customer confirmed unauthorized access via support call #84291…" style={{width:'100%', resize:'vertical', fontFamily:'var(--font-sans)'}}/>
        </div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
          <p style={{margin:0, fontSize:10, color:'var(--color-text-tertiary)'}}>Reviewer: <span style={{color:'var(--color-text-secondary)'}}>{displayName(user)}{user?.username ? ` · ${user.username}` : ''}</span></p>
          <div style={{display:'flex', gap:6}}>
            <button onClick={()=>nav('tx')}>Cancel</button>
            <button className={action === 'confirm' ? 'danger-bg' : 'success-bg'} disabled={!reason.trim()} onClick={submit}>
              {action === 'confirm' ? 'Confirm fraud' : 'Release'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function PartyChip({ role, handle, account, tone }) {
  const bg = tone === 'danger' ? 'var(--color-background-danger)' : 'var(--color-background-info)';
  const fg = tone === 'danger' ? 'var(--color-text-danger)' : 'var(--color-text-info)';
  // Prefer the readable account name for both the displayed label and
  // the initials disc. When neither name nor any letters in the handle
  // are available, fall back to the first 2 chars of the handle (which
  // for numeric account numbers gives something like "20", not "XX").
  const primary = (account || '').trim() || (handle || '').trim() || '';
  const secondary = account ? handle : null;
  const lettersFromName = (account || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const initials =
    lettersFromName ||
    (handle || '').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() ||
    (handle || '').slice(0, 2) ||
    '—';
  return (
    <div style={{display:'flex', alignItems:'center', gap:10, minWidth:0}}>
      <div style={{width:32, height:32, borderRadius:'50%', background: bg, color: fg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:500, flexShrink:0}}>{initials}</div>
      <div style={{minWidth:0}}>
        <p className="truncate" style={{margin:0, fontSize:12, fontWeight:500}}>{primary || '—'}</p>
        <p style={{margin:'1px 0 0', fontSize:10, color:'var(--color-text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
          {secondary ? <><span className="mono">{secondary}</span> · {role}</> : role}
        </p>
      </div>
    </div>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div style={{padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)'}}>
      <p className="label-up" style={{margin:0}}>{label}</p>
      <p style={{margin:'2px 0 0', fontSize:18, fontWeight:500, color: tone === 'danger' ? 'var(--color-text-danger)' : 'inherit'}}>{value}</p>
    </div>
  );
}

function FollowupRow({ m }) {
  const isUser = m.role === 'user';
  // Author initials derived from whatever name was stamped onto the message
  // when it was sent — keeps the avatar honest if a different operator
  // replies later in the conversation.
  const initials = (m.author || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase() || '··';
  return (
    <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
      <div style={{width:26, height:26, borderRadius: isUser ? '50%' : 6, background:'var(--color-background-info)', color:'var(--color-text-info)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:10, fontWeight:500}}>
        {isUser ? initials : <Ti name="robot" size={14}/>}
      </div>
      <div style={{flex:1, padding:'8px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)'}}>
        <p style={{margin:0, fontSize:12, lineHeight:1.55}}>{m.body}</p>
        {m.latency && <p style={{margin:'6px 0 0', fontSize:10, color:'var(--color-text-tertiary)'}}>{m.latency}</p>}
      </div>
    </div>
  );
}

function ActionCard({ checked, onClick, title, sub, tone }) {
  const borderColor = checked ? `var(--color-border-${tone})` : 'var(--color-border-tertiary)';
  const bg = checked ? `color-mix(in srgb, var(--color-background-${tone}) 30%, transparent)` : 'transparent';
  const titleColor = checked ? `var(--color-text-${tone})` : 'var(--color-text-primary)';
  return (
    <label onClick={onClick} style={{
      display:'flex', alignItems:'flex-start', gap:10, padding:12,
      border: `${checked ? '1.5px' : '0.5px'} solid ${borderColor}`,
      borderRadius:'var(--border-radius-md)',
      cursor:'pointer',
      background: bg
    }}>
      <input type="radio" checked={checked} onChange={()=>{}} style={{marginTop:2, flexShrink:0}}/>
      <div style={{minWidth:0}}>
        <p style={{margin:0, fontSize:12, fontWeight:500, color: titleColor}}>{title}</p>
        <p style={{margin:'3px 0 0', fontSize:11, color:'var(--color-text-secondary)', lineHeight:1.4}}>{sub}</p>
      </div>
    </label>
  );
}

// Convert a server `DecisionAudit` row into the shape this page reads.
// When the queue already has a copy we merge so we don't lose synthetic
// fields the queue depends on (e.g. `fia.narrative`, `reasonContribs`).
function normaliseDetail(row, fromQueue) {
  const base = fromQueue ? { ...fromQueue } : {};
  return {
    ...base,
    auditId: row.auditId || row.id || base.auditId,
    transactionId: row.transactionId || base.transactionId,
    sender: row.senderId || row.sender || base.sender || '—',
    receiver: row.receiverId || row.receiver || base.receiver || '—',
    // `amount` arrives as a string-numeric (pg numeric); coerce before render.
    amount: Number(row.amount ?? base.amount ?? 0),
    txnType: row.txnType || row.transactionType || base.txnType || '—',
    segment: row.segment || base.segment || '—',
    // Context block from the LEFT JOIN against `transactions` in the
    // audit repo. Null when PAA hasn't flushed yet — UI handles that.
    context: row.context ?? base.context ?? null,
    championScore: Number(row.championScore ?? base.championScore ?? 0),
    // shadowScore may be null when no shadow model is registered — keep null
    // so the UI can render "—" instead of "0.00".
    shadowScore: row.shadowScore == null ? (base.shadowScore == null ? null : Number(base.shadowScore)) : Number(row.shadowScore),
    threshold: Number(row.threshold ?? base.threshold ?? 0.65),
    modelVersion: row.modelVersion || base.modelVersion || 'v1.1.0',
    reasonCodes: row.reasonCodes || base.reasonCodes || [],
    stage: row.stage || base.stage || 'POST_ML',
    preRule: row.preRule || base.preRule || null,
    fia: row.fia || base.fia || { verdict: 'UNCERTAIN', confidence: 0, narrative: '' },
    createdAt: row.createdAt || base.createdAt || null,
    finalDecision: row.finalDecision || base.finalDecision || null,
    mlDecision: row.mlDecision || base.mlDecision || null,
    decisionSource: row.decisionSource || base.decisionSource || null,
    latencyMs: row.latencyMs ?? base.latencyMs ?? null,
  };
}

/**
 * Renders the request-context block surfaced by the audit→transactions
 * JOIN. The audit row exists immediately at predict-time; PAA flushes
 * the matching `transactions` row asynchronously, so a brand-new
 * transaction may arrive with `context === null`. We render a
 * lightweight "still gathering" line in that case rather than printing
 * a wall of dashes.
 *
 * Sections collapse when empty so adopters who only send the core 6
 * fields don't see a sea of placeholders. Order intentionally puts
 * narration first — it's the single most operator-useful line.
 */
function TransactionContext({ context }) {
  // Collapsed by default — the panel sits below the ML decision and an
  // operator who's just scanning a row's decision doesn't need to see
  // 30 fields they didn't ask for. Click the header to expand.
  const [open, setOpen] = useState(false);

  if (!context) {
    return (
      <section className="panel" style={{marginBottom:12, padding:'14px 18px'}}>
        <h2 style={{margin:0, fontSize:14, fontWeight:500}}>Transaction context</h2>
        <p style={{margin:'6px 0 0', fontSize:12, color:'var(--color-text-tertiary)'}}>
          Awaiting PAA flush — the contextual payload appears here once PAA writes the
          <code className="mono"> transactions</code> row (usually within a few seconds of the prediction).
        </p>
      </section>
    );
  }

  const reqCtx = (context && context.requestContext) || {};
  const narration = (reqCtx.narration || reqCtx.description || '').toString().trim();

  // Build (label, value) lists per logical group. Empty groups don't render.
  const sections = [
    {
      title: 'Routing',
      rows: [
        ['Channel', context.channel],
        ['Currency', context.currency],
        ['Provider', reqCtx.provider],
        ['Transfer type', reqCtx.transfer_type || reqCtx.transferType],
        ['Fee', reqCtx.fee != null ? String(reqCtx.fee) : null],
        ['Sender FI', context.customerFi],
        ['Recipient FI', context.recipientFi],
        ['Recurring', context.isRecurring == null ? null : context.isRecurring ? 'yes' : 'no'],
        ['Inflow', context.isInflow == null ? null : context.isInflow ? 'yes' : 'no'],
      ],
    },
    {
      title: 'Customer',
      rows: [
        ['Date of birth', context.customerDob],
        ['Nationality', context.customerNationality],
        ['Type', context.customerType],
        ['ID type', context.customerIdType],
        ['Account age (days)', context.accountAgeDays],
        ['Authenticated', context.isAuthenticated == null ? null : context.isAuthenticated ? 'yes' : 'no'],
        ['Wallet balance', context.walletBalance],
      ],
    },
    {
      title: 'Recipient',
      rows: [
        ['Nationality', context.recipientNationality],
        ['ID type', context.recipientIdType],
      ],
    },
    {
      title: 'Geography',
      rows: [
        ['Customer location', fmtLatLng(context.customerLatitude, context.customerLongitude)],
        ['Transaction location', fmtLatLng(context.transactionLat, context.transactionLng)],
        ['Transaction country', context.transactionCountry],
        ['Destination country', context.destinationCountry],
        ['IP country', context.ipCountry],
        ['IP via VPN', context.ipIsVpn == null ? null : context.ipIsVpn ? 'yes' : 'no'],
      ],
    },
    {
      title: 'Device / session',
      rows: [
        ['Device type', context.deviceType],
        ['Trusted device', context.deviceIsTrusted == null ? null : context.deviceIsTrusted ? 'yes' : 'no'],
        ['Session→txn (s)', context.sessionToTxnSeconds],
        ['Browser', context.deviceFingerprint?.browser],
        ['OS', context.deviceFingerprint?.os],
        ['Screen', context.deviceFingerprint?.screen_resolution],
      ],
    },
    {
      title: 'Agent',
      rows: [['Agent id', context.agentId]],
    },
  ]
    .map((s) => ({ ...s, rows: s.rows.filter(([, v]) => v != null && v !== '') }))
    .filter((s) => s.rows.length > 0);

  if (sections.length === 0 && !narration) {
    // Empty context (everything PAA persisted is null). Hide the panel
    // — rendering nothing is better than a header followed by a blank.
    return null;
  }

  // Compact summary shown next to the collapsed-state chevron — gives
  // the operator a one-line idea of what's inside without expanding.
  const summaryParts = [
    context.channel && context.currency ? `${context.channel} · ${context.currency}` : context.channel || context.currency,
    sections.length > 0 ? `${sections.reduce((n, s) => n + s.rows.length, 0)} fields` : null,
    narration ? 'narration' : null,
  ].filter(Boolean);

  const toggle = () => setOpen((v) => !v);

  return (
    <section className="panel" style={{marginBottom:12, padding:'14px 18px'}}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="txn-context-body"
        style={{
          display:'flex',
          alignItems:'center',
          justifyContent:'space-between',
          gap:12,
          width:'100%',
          padding:0,
          background:'transparent',
          border:'none',
          cursor:'pointer',
          textAlign:'left',
          color:'inherit',
        }}
      >
        {/* Header gets the same icon-disc treatment as the FIA panel
            and a leading colored disc — the previous flat row blended
            into the page chrome and operators were missing the panel
            entirely. Chevron moves to the right edge so it reads as a
            "show more" affordance instead of a list bullet. */}
        <div style={{display:'flex', alignItems:'center', gap:8, minWidth:0, flex:1}}>
          <div
            style={{
              width:24, height:24, borderRadius:6,
              background:'var(--color-background-info)',
              color:'var(--color-text-info)',
              display:'flex', alignItems:'center', justifyContent:'center',
              flexShrink:0,
            }}
          >
            <Ti name="list-details" size={14}/>
          </div>
          <h2 style={{margin:0, fontSize:14, fontWeight:500, flexShrink:0}}>Transaction context</h2>
          {!open && narration && (
            <span
              className="truncate"
              style={{fontSize:12, color:'var(--color-text-secondary)', fontStyle:'italic', minWidth:0}}
              title={narration}
            >
              · "{narration}"
            </span>
          )}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:8, flexShrink:0}}>
          {!open && summaryParts.length > 0 && (
            <span className="truncate" style={{fontSize:11, color:'var(--color-text-tertiary)', maxWidth:260}}>
              {summaryParts.join(' · ')}
            </span>
          )}
          <span style={{fontSize:11, color:'var(--color-text-info)', fontWeight:500, whiteSpace:'nowrap'}}>
            {open ? 'Hide' : 'Show details'}
          </span>
          <Ti name={open ? 'chevron-up' : 'chevron-down'} size={14} style={{color:'var(--color-text-info)', flexShrink:0}}/>
        </div>
      </button>
      {open && (
        <div id="txn-context-body" style={{marginTop:14}}>
          {narration && (
            <div style={{padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', marginBottom:12}}>
              <p className="label-up" style={{margin:0}}>Narration</p>
              <p style={{margin:'4px 0 0', fontSize:13, lineHeight:1.5}}>{narration}</p>
            </div>
          )}
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:14}}>
            {sections.map((s) => (
              <div key={s.title}>
                <p className="label-up" style={{margin:'0 0 6px'}}>{s.title}</p>
                <div style={{display:'flex', flexDirection:'column', gap:4}}>
                  {s.rows.map(([k, v]) => (
                    <div key={k} style={{display:'grid', gridTemplateColumns:'120px 1fr', gap:8, fontSize:12}}>
                      <span style={{color:'var(--color-text-tertiary)'}}>{k}</span>
                      <span className="truncate" style={{fontFamily: looksLikeId(v) ? 'var(--font-mono)' : undefined}}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Hero pill — derives both label and tone from the actual decision on
 * the audit row. Previously this was hardcoded to "DECLINE · {ML|RULE}"
 * because the detail page was only opened from the review queue, but
 * Sentinel now navigates here from the recent-decisions list too where
 * the row may be ACCEPT or REVIEW.
 *
 * `source` (decisionSource) is the layer that produced the final call
 * — ML, PRE_RULE, or POST_RULE. We render the human form ("ML" /
 * "RULE") to match the existing label vocabulary.
 */
function DecisionPill({ decision, source, stage }) {
  const finalDecision = decision || 'ACCEPT';
  const tone = finalDecision === 'DECLINE' ? 'danger' : finalDecision === 'REVIEW' ? 'warn' : 'success';
  const isRule = source === 'PRE_RULE' || source === 'POST_RULE' || stage === 'PRE_RULE';
  const label = isRule ? 'RULE' : 'ML';
  return (
    <span className={`pill ${tone}`} style={{padding:'4px 10px', fontSize:11, flexShrink:0}}>
      {finalDecision} · {label}
    </span>
  );
}

function fmtLatLng(lat, lng) {
  if (lat == null && lng == null) return null;
  const f = (v) => (v == null ? '—' : Number(v).toFixed(4));
  return `${f(lat)}, ${f(lng)}`;
}

function looksLikeId(v) {
  if (typeof v !== 'string') return false;
  return /^[A-Za-z]{2,4}_/.test(v) || /^\d{6,}$/.test(v);
}

export default TransactionDetail;
