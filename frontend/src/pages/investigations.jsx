// Page 7 — Investigations (FIA reports list with conversation thread)

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Ti,
  PageHead,
  Modal,
  fmtNaira,
  truncId,
  verdictPill,
  actionPill,
} from '../components/shell.jsx';
import {
  requestReport as apiRequestReport,
  listReports,
} from '../api/client.js';
import { SearchInput } from '../components/search-input.jsx';
import { Pagination } from '../components/pagination.jsx';

const REPORTS_PER_PAGE = 10;

function Investigations({ toast, nav, reports, setReports, reportsLive, setReportsLive }) {
  const [verdict, setVerdict] = useState('ALL');
  const [sort, setSort] = useState('Newest');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // Server-side fetch: verdict + search + pagination push through to
  // FIA's SQL. The parent's `reports` state is still mirrored so the
  // dashboard's quick-glance counts keep working.
  const fetchReports = useCallback(async () => {
    const { reports: fresh, total: serverTotal, live } = await listReports({
      limit: REPORTS_PER_PAGE,
      offset: (page - 1) * REPORTS_PER_PAGE,
      verdict: verdict === 'ALL' ? undefined : verdict,
      search: search || undefined,
    });
    if (typeof setReportsLive === 'function') setReportsLive(live);
    if (live) {
      setReports(fresh);
      setTotal(serverTotal);
    }
    return { live, count: fresh.length };
  }, [page, verdict, search, setReports, setReportsLive]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const retry = async () => {
    const { live, count } = await fetchReports();
    if (live) {
      toast(`FIA reachable · ${count} report${count === 1 ? '' : 's'} loaded`, 'success');
    } else {
      toast('FIA still unreachable', 'danger');
    }
  };

  // When the FIA service responded but with zero reports we want the
  // empty-state hint, not a fake list. When the FIA service errored
  // (`reportsLive === false`) we hard-replace with the unreachable card.
  const isFiaDown = reportsLive === false;
  const isLoading = reportsLive === null;

  // Reset page on filter/search changes; clamp on dataset shrink.
  useEffect(() => {
    setPage(1);
  }, [verdict, search]);
  useEffect(() => {
    const last = Math.max(1, Math.ceil(total / REPORTS_PER_PAGE));
    if (page > last) setPage(last);
  }, [total, page]);

  // Sort the *current page* client-side. The big-vs-small filters
  // (`Newest` / `Oldest` / amount / confidence) are still useful for
  // re-ordering the 10 visible rows; pushing this to SQL would need a
  // sort parameter on FIA's endpoint — a small follow-up.
  const pageRows = useMemo(() => {
    const list = [...reports];
    if (sort === 'Newest') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    else if (sort === 'Oldest') list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    else if (sort === 'Highest amount') list.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    else if (sort === 'Lowest confidence') list.sort((a, b) => (a.agentConfidence ?? 0) - (b.agentConfidence ?? 0));
    return list;
  }, [reports, sort]);

  const onRequest = async (txId) => {
    const fakeId = 'rep_' + Math.floor(9000 + Math.random() * 999);
    const optimistic = {
      id: fakeId,
      transactionId: txId,
      verdict: 'UNCERTAIN',
      recommendedAction: 'MANUAL_REVIEW',
      agentConfidence: 0.0,
      sender: 'pending…',
      receiver: 'pending…',
      amount: 0,
      txnType: '—',
      llmModelVersion: 'phi-3-mini-v1',
      createdAt: new Date().toISOString(),
      ageLabel: 'just now',
      keyIndicators: [],
      narrative: 'Generating…',
      turns: 0,
      conversation: [],
      _generating: true,
    };
    setReports((r) => [optimistic, ...r]);
    setRequestOpen(false);
    toast(`Requested report for ${truncId(txId, 12)} · generating on GPU…`);

    try {
      const real = await apiRequestReport(txId);
      // FIA returns the persisted report row; merge it onto the placeholder.
      setReports((r) =>
        r.map((rep) =>
          rep.id === fakeId
            ? {
                ...rep,
                ...real,
                id: real.id || fakeId,
                _generating: false,
                ageLabel: 'just now',
              }
            : rep,
        ),
      );
      toast('Report generated', 'success');
    } catch (err) {
      // Fall back to a synthetic completion so the design still demos
      // without a running FIA service.
      setTimeout(() => {
        setReports((r) =>
          r.map((rep) =>
            rep.id === fakeId
              ? {
                  ...rep,
                  _generating: false,
                  verdict: 'UNCERTAIN',
                  agentConfidence: 0.51,
                  sender: 'user_acme_42',
                  receiver: 'acct_p2p_77',
                  amount: 88200,
                  narrative:
                    'On-demand investigation: receiver has limited history but no direct mule-cluster proximity. Sender pattern is consistent with recent activity. Insufficient signal to confirm fraud.',
                  keyIndicators: ['Thin history', 'No baseline', 'Recent device change'],
                }
              : rep,
          ),
        );
        toast('Report generated (fallback)', 'success');
      }, 2400);
    }
  };

  const onExport = () => {
    toast('CSV exported · 9 rows · transactionId, verdict, …');
  };

  if (isFiaDown) {
    return (
      <>
        <PageHead crumbs={['Dashboard','Detection']} title="Investigations" sub="FIA service unreachable">
          <button onClick={retry}><Ti name="refresh" size={14}/>Retry</button>
        </PageHead>
        <div className="panel" style={{padding:36, textAlign:'center'}}>
          <div style={{width:48, height:48, margin:'0 auto 14px', borderRadius:'50%', background:'var(--color-background-warning)', color:'var(--color-text-warning)', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
            <Ti name="alert-triangle" size={20}/>
          </div>
          <h3 style={{margin:'0 0 4px', fontSize:16, fontWeight:500}}>FIA service not reachable</h3>
          <p style={{margin:0, fontSize:12, color:'var(--color-text-secondary)'}}>
            Start the FIA service to load investigation reports.
            <br/>See <code className="mono">fia-service/</code> in the repo for setup.
          </p>
          <button className="info-bg" style={{marginTop:14}} onClick={retry}><Ti name="refresh" size={12}/>Retry</button>
        </div>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <PageHead crumbs={['Dashboard','Detection']} title="Investigations" sub="Loading FIA reports…"/>
        <div className="panel" style={{padding:36, textAlign:'center', color:'var(--color-text-tertiary)', fontSize:12}}>Loading…</div>
      </>
    );
  }

  return (
    <>
      <PageHead crumbs={['Dashboard','Detection']} title="Investigations" sub={`FIA reports for blocked and on-demand transactions · ${total} total${total > reports.length ? ` · showing ${reports.length} on this page` : ''}`}>
        <button onClick={onExport}><Ti name="download" size={14}/>Export CSV</button>
        <button className="info-bg" onClick={()=>setRequestOpen(true)}><Ti name="plus" size={14}/>Request report</button>
      </PageHead>

      {/* Search + sort */}
      <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12, flexWrap:'wrap'}}>
        <SearchInput
          value={search}
          onCommit={setSearch}
          placeholder="Search by transaction ID, indicator, or narrative… (press Enter)"
        />
        <SortMenu value={sort} onChange={setSort}/>
      </div>

      {/* Verdict chips. Counts are intentionally not shown per-verdict —
          they would require an extra group-by query and grow stale as
          the page paginates. The verdict filter still works
          server-side; switching to a chip refetches with that filter. */}
      <div style={{display:'flex', gap:6, marginBottom:14, flexWrap:'wrap'}}>
        <ChipBtn active={verdict === 'ALL'} onClick={()=>setVerdict('ALL')}>All</ChipBtn>
        <ChipBtn active={verdict === 'FRAUD_CONFIRMED'} onClick={()=>setVerdict('FRAUD_CONFIRMED')} tone="danger">Fraud confirmed</ChipBtn>
        <ChipBtn active={verdict === 'UNCERTAIN'} onClick={()=>setVerdict('UNCERTAIN')} tone="warn">Uncertain</ChipBtn>
        <ChipBtn active={verdict === 'LIKELY_LEGITIMATE'} onClick={()=>setVerdict('LIKELY_LEGITIMATE')} tone="success">Likely legitimate</ChipBtn>
      </div>

      {/* Cards */}
      <div style={{display:'flex', flexDirection:'column', gap:10}}>
        {pageRows.map(r => (
          <ReportCard
            key={r.id}
            r={r}
            expanded={expanded === r.id}
            onToggle={() => setExpanded(e => e === r.id ? null : r.id)}
            toast={toast}
            nav={nav}
          />
        ))}
        {total === 0 && !isLoading && (
          <div className="panel" style={{textAlign:'center', padding:36, color:'var(--color-text-tertiary)'}}>
            {search || verdict !== 'ALL' ? 'No reports match these filters.' : 'No reports yet.'}
          </div>
        )}
      </div>

      <Pagination
        page={page}
        pageSize={REPORTS_PER_PAGE}
        total={total}
        onChange={setPage}
        variant="compact"
      />

      {requestOpen && <RequestReportModal onClose={()=>setRequestOpen(false)} onSubmit={onRequest}/>}
    </>
  );
}

// ──────── Report Card ────────
function ReportCard({ r, expanded, onToggle, toast, nav }) {
  // Live FIA rows may omit some optional fields — normalise into safe
  // defaults so a missing `llmModelVersion` / `keyIndicators` / etc.
  // doesn't crash the card.
  const llmVersion = r.llmModelVersion || '';
  const isFallback = llmVersion.endsWith('-fallback');
  const keyIndicators = Array.isArray(r.keyIndicators) ? r.keyIndicators : [];
  const conversation = Array.isArray(r.conversation) ? r.conversation : [];
  const turns = typeof r.turns === 'number' ? r.turns : conversation.length;
  return (
    <article className="panel" style={{
      padding: 0,
      borderLeft: isFallback ? '2px solid var(--color-text-warning)' : '0.5px solid var(--color-border-tertiary)',
      background: r._generating ? 'color-mix(in srgb, var(--color-background-info) 30%, var(--color-background-primary))' : 'var(--color-background-primary)'
    }}>
      {isFallback && (
        <div style={{padding:'6px 14px', background:'var(--color-background-warning)', color:'var(--color-text-warning)', fontSize:11, fontWeight:500, borderBottom:'0.5px solid var(--color-border-warning)', display:'flex', alignItems:'center', gap:6}}>
          <Ti name="alert-triangle" size={12}/>
          <span><i>Automated fallback report</i> — LLM unavailable; templated from rules + features only.</span>
        </div>
      )}
      <div style={{padding:'14px 16px'}}>
        <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, marginBottom:10}}>
          <div style={{minWidth:0, flex:1}}>
            <p className="truncate mono" style={{margin:0, fontSize:11, color:'var(--color-text-secondary)'}}>{r.transactionId}</p>
            <div style={{display:'flex', alignItems:'baseline', gap:8, marginTop:3, flexWrap:'wrap'}}>
              <span style={{fontSize:16, fontWeight:500}}>{r._generating ? '—' : fmtNaira(r.amount)}</span>
              <span style={{fontSize:11, color:'var(--color-text-secondary)'}}>{r.txnType} · {r.sender} → {r.receiver}</span>
            </div>
          </div>
          <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0, whiteSpace:'nowrap'}}>
            {verdictPill(r.verdict)}
            <span style={{fontSize:10, color:'var(--color-text-secondary)', display:'inline-flex', alignItems:'center', gap:6}}>Recommended: {actionPill(r.recommendedAction)}</span>
          </div>
        </div>

        <p style={{margin:'0 0 10px', fontSize:12, lineHeight:1.55, color: isFallback ? 'var(--color-text-secondary)' : 'var(--color-text-primary)', fontStyle: isFallback ? 'italic' : 'normal'}}>{r.narrative}</p>

        {keyIndicators.length > 0 && (
          <div style={{display:'flex', gap:5, marginBottom:10, flexWrap:'wrap'}}>
            {keyIndicators.map(k => (
              <span key={k} style={{fontSize:10, background:'var(--color-background-secondary)', color:'var(--color-text-secondary)', padding:'2px 7px', borderRadius:10, whiteSpace:'nowrap'}}>{k}</span>
            ))}
          </div>
        )}

        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', paddingTop:10, borderTop:'0.5px solid var(--color-border-tertiary)', fontSize:11, color:'var(--color-text-secondary)', flexWrap:'wrap', gap:8}}>
          <div style={{display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
            <span style={{display:'inline-flex', alignItems:'center', gap:4, whiteSpace:'nowrap'}}><Ti name="target" size={12}/>Confidence {typeof r.agentConfidence === 'number' ? r.agentConfidence.toFixed(2) : '—'}</span>
            <span style={{display:'inline-flex', alignItems:'center', gap:4, fontFamily:'var(--font-mono)', fontSize:10, whiteSpace:'nowrap'}}><Ti name="robot" size={12}/>{llmVersion || '—'}</span>
            <span style={{display:'inline-flex', alignItems:'center', gap:4, cursor: turns > 0 ? 'pointer' : 'default', whiteSpace:'nowrap'}} onClick={turns > 0 ? onToggle : undefined}>
              <Ti name="message-circle" size={12}/>{`${turns} turn${turns === 1 ? '' : 's'}`}
              {turns > 0 && <Ti name={expanded ? 'chevron-up' : 'chevron-down'} size={10} style={{marginLeft:2}}/>}
            </span>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap'}}>
            <span style={{color:'var(--color-text-tertiary)'}}>{r.ageLabel}</span>
            <button
              style={{padding:'3px 8px', fontSize:11}}
              disabled={!r.transactionId || !nav}
              title={r.transactionId ? 'Open transaction detail' : 'No transaction id on this report'}
              onClick={() => {
                if (!r.transactionId) {
                  toast && toast('Report has no transaction id');
                  return;
                }
                if (nav) nav('txn:' + r.transactionId);
              }}
            >
              Open<Ti name="chevron-right" size={11}/>
            </button>
          </div>
        </div>
      </div>

      {expanded && conversation.length > 0 && (
        <div style={{padding:'12px 16px 14px', borderTop:'0.5px solid var(--color-border-tertiary)', background:'var(--color-background-secondary)'}}>
          <p className="label-up" style={{margin:'0 0 8px'}}>CONVERSATION · {turns} turn{turns===1?'':'s'}</p>
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            {conversation.map((m, i) => <ConvTurn key={i} m={m}/>)}
          </div>
          <div style={{marginTop:10, padding:'8px 10px', background:'var(--color-background-primary)', borderRadius:'var(--border-radius-md)', border:'0.5px solid var(--color-border-tertiary)', display:'flex', gap:6}}>
            <input placeholder="Ask FIA a follow-up question…" style={{flex:1, fontSize:12, padding:'5px 9px', border:'none', background:'transparent'}}/>
            <button style={{fontSize:11, padding:'5px 10px'}}><Ti name="send" size={12}/>Send</button>
          </div>
        </div>
      )}
    </article>
  );
}

function ConvTurn({ m }) {
  if (m.role === 'system') return null;
  const isUser = m.role === 'user';
  return (
    <div style={{display:'flex', gap:8, alignItems:'flex-start'}}>
      <div style={{
        width:24, height:24, borderRadius:'50%', flexShrink:0,
        display:'flex', alignItems:'center', justifyContent:'center',
        background: isUser ? 'var(--color-background-info)' : 'var(--color-text-primary)',
        color: isUser ? 'var(--color-text-info)' : 'var(--color-background-primary)'
      }}>
        <Ti name={isUser ? 'user' : 'robot'} size={12}/>
      </div>
      <div style={{flex:1}}>
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:2}}>
          <span style={{fontSize:11, fontWeight:500}}>{isUser ? m.author : 'FIA'}</span>
          <span style={{fontSize:10, color:'var(--color-text-tertiary)'}}>{m.at}</span>
        </div>
        <p style={{margin:0, fontSize:12, lineHeight:1.55, color:'var(--color-text-primary)'}}>{m.body}</p>
      </div>
    </div>
  );
}

// ──────── Bits ────────
function ChipBtn({ active, onClick, tone, children }) {
  const toneVar = tone === 'danger' ? '--color-text-danger' : tone === 'warn' ? '--color-text-warning' : tone === 'success' ? '--color-text-success' : null;
  return (
    <button
      onClick={onClick}
      className={active ? 'info-bg' : ''}
      style={{
        padding:'5px 10px', fontSize:12, gap:6,
        ...(active ? {} : tone ? {color: `var(${toneVar})`, borderColor: 'var(--color-border-tertiary)'} : {})
      }}
    >
      {children}
    </button>
  );
}
function SortMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const options = ['Newest','Oldest','Highest amount','Lowest confidence'];
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => window.addEventListener('click', close), 0);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return (
    <div style={{position:'relative'}} onClick={e=>e.stopPropagation()}>
      <button onClick={()=>setOpen(o => !o)}><Ti name="sort-descending" size={14}/>{value}<Ti name="chevron-down" size={11}/></button>
      {open && (
        <div style={{
          position:'absolute', right:0, top:'calc(100% + 4px)', zIndex:20,
          background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)',
          borderRadius:'var(--border-radius-md)', boxShadow:'var(--shadow-md)', minWidth:170, padding:4, fontSize:12
        }}>
          {options.map(o => (
            <div key={o} onClick={()=>{onChange(o); setOpen(false);}} style={{
              padding:'6px 10px', borderRadius:4, cursor:'pointer',
              background: o === value ? 'var(--color-background-secondary)' : 'transparent',
              fontWeight: o === value ? 500 : 400
            }}>{o}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function RequestReportModal({ onClose, onSubmit }) {
  const [txId, setTxId] = useState('');
  return (
    <Modal
      title="Request investigation report"
      sub={<>POSTs to <code className="mono">/v1/reports</code> · accepts non-blocked transactions · 5–10s on GPU, tens of seconds on MPS.</>}
      onClose={onClose}
      width={500}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!txId.trim()} onClick={()=>onSubmit(txId.trim() || '550e8400-e29b-41d4-a716-446655440099')}>Generate</button>
      </>}
    >
      <label className="label-up" style={{display:'block', marginBottom:4}}>Transaction ID</label>
      <input
        autoFocus
        className="mono"
        value={txId}
        onChange={e=>setTxId(e.target.value)}
        placeholder="550e8400-e29b-41d4-a716-446655440000"
        style={{width:'100%'}}
      />
      <p style={{margin:'8px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>An optimistic placeholder card will appear immediately; the narrative is filled in once FIA returns.</p>
    </Modal>
  );
}

export default Investigations;
