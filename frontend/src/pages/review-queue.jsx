// Page 4 — Review queue (Sentinel · keyboard-first triage)
//
// Wired to `GET /v1/review-queue`. Search commits on Enter / blur so we
// don't refetch on every keystroke. Confirm / Release fire `POST
// /v1/decisions/:auditId/override` and optimistically remove the row.

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Ti,
  PageHead,
  Modal,
  fmtNaira,
  fmtAge,
  ageTone,
  truncId,
} from '../components/shell.jsx';
import { SearchInput } from '../components/search-input.jsx';
import { Pagination } from '../components/pagination.jsx';

const QUEUE_PAGE_SIZE = 25;
import {
  listReviewQueue,
  overrideDecision,
  listSimilarDecisions,
  requestReport,
  postReportMessage,
} from '../api/client.js';

// Normalise a backend audit row into the shape the queue UI expects.
// Server rows lack the `fia` block and a few synthetic fields, so we
// degrade gracefully when those are missing.
//
// `reasonCodes` from the API is an array of objects
//   [{ code, value, description, contribution }, …]
// — the UI used to assume a flat string array, which made React throw
// "Objects are not valid as a React child" and blank the page. We
// flatten to two parallel arrays here.
function normaliseQueueRow(r) {
  const rawReasons = Array.isArray(r.reasonCodes) ? r.reasonCodes : [];
  const reasonCodes = rawReasons.map((c) => (typeof c === 'string' ? c : c?.code || ''));
  const reasonContribs = Array.isArray(r.reasonContribs)
    ? r.reasonContribs
    : rawReasons.map((c) => (typeof c === 'object' && c?.contribution != null ? Number(c.contribution) : 0.1));

  // Pre-rule short-circuits live on `decisionSource` ('PRE_RULE') /
  // `ruleStage` ('PRE'); fall back to the legacy synthetic `stage` /
  // `preRule` fields when the row came from the mock seed.
  const isPreRule = r.stage === 'PRE_RULE'
    || r.decisionSource === 'PRE_RULE'
    || r.ruleStage === 'PRE';

  return {
    auditId: r.auditId || r.id,
    transactionId: r.transactionId,
    sender: r.senderId || r.sender || '—',
    receiver: r.receiverId || r.receiver || '—',
    amount: Number(r.amount ?? 0),
    segment: r.segment || '—',
    txnType: r.txnType || r.transactionType || '—',
    championScore: Number(r.championScore ?? 0),
    shadowScore: r.shadowScore == null ? null : Number(r.shadowScore),
    threshold: Number(r.threshold ?? 0.65),
    modelVersion: r.modelVersion || r.championModelVersion || '—',
    ageMin: r.ageMin ?? Math.max(0, Math.round((Date.now() - new Date(r.createdAt || Date.now()).getTime()) / 60000)),
    reasonCodes,
    reasonContribs,
    finalDecision: r.finalDecision || 'DECLINE',
    stage: isPreRule ? 'PRE_RULE' : 'POST_ML',
    preRule: r.preRule || r.ruleName || null,
    fia: r.fia || { verdict: 'UNCERTAIN', confidence: 0, narrative: 'No FIA report yet.' },
    similar: r.similar || [],
  };
}

function ReviewQueue({ toast, nav, queue, setQueue, queueCount, refreshQueueCount }) {
  // Trigger the parent's count refresh after every override action. If
  // the parent didn't pass one through (e.g. older callsite), fall back
  // to a noop so the page still works.
  const bumpCount = refreshQueueCount || (() => {});
  const [focus, setFocus] = useState(0);
  const [bulk, setBulk] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  // Sort toggle: 'oldest' surfaces the longest-waiting row first, 'newest'
  // mirrors the server default. Header chip flips it.
  const [sortOrder, setSortOrder] = useState('newest');
  // Server-side pagination — the queue table can run into the thousands
  // so we never load it all at once. `page` is 1-indexed; `pageTotal` is
  // the server's authoritative count for "rows matching the queue
  // filter" (unreviewed DECLINEs).
  const [page, setPage] = useState(1);
  const [pageTotal, setPageTotal] = useState(0);
  // Similar-case detail modal (right pane, similar-cases section). When
  // non-null the modal renders with the clicked row's full payload and
  // a "Open transaction" jump.
  const [similarOpen, setSimilarOpen] = useState(null);
  const [needInfoOpen, setNeedInfoOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(null); // 'confirm' | 'release' | null
  // Bulk-action modal — same shape as the single-row OverrideModal but for
  // many rows at once. `null` when closed, `'confirm'` / `'release'` when open.
  const [bulkAction, setBulkAction] = useState(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  // Starts at 0 — counts only items reviewed in this browser session. The
  // backend doesn't surface "how many reviews this analyst did today"
  // anywhere, so a session counter is the honest read.
  const [handledToday, setHandledToday] = useState(0);
  // Similar cases fetched on-demand for the focused row. Keyed by auditId
  // so the panel doesn't flicker between focus changes.
  const [similar, setSimilar] = useState({});
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // `refreshing` is true while we're pulling the next batch from the
  // server — used by the empty-state guard so a depleted local list
  // doesn't flash "Queue clear" before the refetched rows arrive.
  const [refreshing, setRefreshing] = useState(true);

  const refetchQueue = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await listReviewQueue({
        limit: QUEUE_PAGE_SIZE,
        offset: (page - 1) * QUEUE_PAGE_SIZE,
        order: sortOrder,
        search,
      });
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      setQueue(rows.map(normaliseQueueRow));
      setPageTotal(Number(res?.total) || 0);
    } catch {
      /* tolerate offline */
    } finally {
      setRefreshing(false);
    }
  }, [setQueue, page, sortOrder, search]);

  // On mount + whenever page / sort changes, refresh from the server.
  useEffect(() => {
    refetchQueue();
    setFocus(0);
  }, [refetchQueue]);

  // Clamp the page when a refresh shrinks the result set (e.g. bulk
  // override drained the last page). Without this the user would be
  // stranded on an empty page > totalPages with no rows to show.
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(pageTotal / QUEUE_PAGE_SIZE));
    if (page > lastPage) setPage(lastPage);
  }, [pageTotal, page]);

  // Server-side search now — refetchQueue sends `search` and the
  // backend ILIKEs across transactionId / senderId / receiverId. The
  // queue state already holds only matching rows, so no local filter.
  const filtered = queue;

  const current = filtered[focus] || null;

  // Fetch similar cases for the focused row.
  useEffect(() => {
    if (!current?.auditId) return undefined;
    if (similar[current.auditId]) return undefined;
    let cancelled = false;
    listSimilarDecisions(current.auditId, { limit: 5 })
      .then((rows) => {
        if (cancelled) return;
        setSimilar((m) => ({ ...m, [current.auditId]: Array.isArray(rows) ? rows : [] }));
      })
      .catch(() => {
        setSimilar((m) => ({ ...m, [current.auditId]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [current?.auditId]);

  useEffect(() => {
    const onKey = (e) => {
      if (overrideOpen || needInfoOpen) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocus(f => Math.min(filtered.length - 1, f + 1)); }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocus(f => Math.max(0, f - 1)); }
      if (!current) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setOverrideOpen('confirm'); }
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setOverrideOpen('release'); }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setNeedInfoOpen(true); }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); doSkip(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, focus, current, overrideOpen, needInfoOpen]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-focused="1"]');
    if (el) {
      const r = el.getBoundingClientRect();
      const p = listRef.current.getBoundingClientRect();
      if (r.top < p.top || r.bottom > p.bottom) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [focus]);

  const totalExposure = queue.reduce((a, b) => a + b.amount, 0);
  const slaCount = queue.filter(q => q.ageMin >= 240).length;

  const doSkip = () => {
    if (!current) return;
    toast(`Skipped ${current.auditId} — still in queue`);
    setFocus(f => Math.min(filtered.length - 1, f + 1));
  };

  const doConfirm = async (reason) => {
    setOverrideOpen(null);
    const target = current;
    setQueue(q => q.filter(x => x.auditId !== target.auditId));
    setHandledToday(h => h + 1);
    setFocus(f => Math.min(filtered.length - 2, f));
    try {
      await overrideDecision(target.auditId, { decision: 'DECLINE', reason, fraudLabel: true });
      toast(`Confirmed fraud · ${target.auditId} · MLA gets new label`, 'danger');
      bumpCount();
      // Refetch so the next pending DECLINE slides into the visible list.
      // Without this the user can deplete the local 100-row cap and
      // see "Queue clear" while there are still rows server-side.
      refetchQueue();
    } catch (err) {
      toast(`Confirm failed · ${parseErr(err)}`, 'danger');
      // Re-insert the row at the head so the user can retry.
      setQueue(q => [target, ...q]);
    }
  };
  const doRelease = async (reason) => {
    setOverrideOpen(null);
    const target = current;
    setQueue(q => q.filter(x => x.auditId !== target.auditId));
    setHandledToday(h => h + 1);
    setFocus(f => Math.min(filtered.length - 2, f));
    try {
      await overrideDecision(target.auditId, { decision: 'ACCEPT', reason });
      toast(`Released ${target.auditId} · decision.overridden fired`, 'success');
      bumpCount();
      refetchQueue();
    } catch (err) {
      toast(`Release failed · ${parseErr(err)}`, 'danger');
      setQueue(q => [target, ...q]);
    }
  };

  // Set helpers for the bulk-action toolbar.
  const visibleIds = useMemo(() => filtered.map((r) => r.auditId), [filtered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Prune the selection whenever the queue array shrinks so stale ids
  // (removed by an override, server refresh, or filter change) don't
  // inflate the "N selected" count.
  useEffect(() => {
    if (selected.size === 0) return;
    const live = new Set(queue.map((q) => q.auditId));
    let dirty = false;
    for (const id of selected) if (!live.has(id)) { dirty = true; break; }
    if (!dirty) return;
    setSelected((prev) => {
      const next = new Set();
      for (const id of prev) if (live.has(id)) next.add(id);
      return next;
    });
  }, [queue]);

  /**
   * Persist a bulk override. Fires `POST /v1/decisions/:auditId/override`
   * for each selected audit row with the same reason; runs in small
   * parallel batches so a long selection doesn't hammer the backend in
   * one shot. Rows are removed optimistically; any that 4xx'd are
   * re-inserted at the head and reported via toast.
   */
  const doBulk = async (kind, reason) => {
    if (bulkRunning) return;
    const targets = queue.filter((q) => selected.has(q.auditId));
    if (targets.length === 0) {
      setBulkAction(null);
      return;
    }
    setBulkRunning(true);
    // Optimistic remove — we'll reinsert failures below.
    setQueue((q) => q.filter((x) => !selected.has(x.auditId)));
    setSelected(new Set());

    const PARALLELISM = 5;
    const decision = kind === 'confirm' ? 'DECLINE' : 'ACCEPT';
    const fraudLabel = kind === 'confirm';
    const failures = [];
    let i = 0;
    const next = async () => {
      while (i < targets.length) {
        const my = i++;
        const t = targets[my];
        try {
          await overrideDecision(t.auditId, { decision, reason, fraudLabel });
        } catch (err) {
          failures.push({ t, msg: String(err?.message || err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLELISM, targets.length) }, next));

    const succeeded = targets.length - failures.length;
    setHandledToday((h) => h + succeeded);
    if (failures.length > 0) {
      // Reinsert the failed rows at the head so the user can retry.
      setQueue((q) => [...failures.map((f) => f.t), ...q]);
    }
    setBulkRunning(false);
    setBulkAction(null);
    bumpCount();
    // Pull the next batch in from the server — bulk likely drained the
    // local 100-row cap; without a refetch the UI will mis-show
    // "Queue clear" while pending rows remain server-side.
    refetchQueue();
    if (failures.length === 0) {
      toast(
        `${kind === 'confirm' ? 'Confirmed' : 'Released'} ${succeeded} item${succeeded === 1 ? '' : 's'}`,
        kind === 'confirm' ? 'danger' : 'success',
      );
    } else {
      toast(
        `${succeeded} succeeded, ${failures.length} failed (e.g. ${failures[0].msg.slice(0, 80)})`,
        'danger',
      );
    }
  };

  // Empty-state guard now reads the *server's authoritative* page
  // total, not just the local slice. Three signals have to agree:
  //   1. local queue is empty,
  //   2. we're not in the middle of a refetch,
  //   3. server total = 0.
  if (queue.length === 0 && !refreshing && pageTotal === 0) {
    return (
      <EmptyQueue
        handledToday={handledToday}
        onRefresh={async () => {
          await refetchQueue();
          bumpCount();
          toast('Queue refreshed');
        }}
      />
    );
  }
  if (queue.length === 0 && (refreshing || pageTotal > 0)) {
    return (
      <div className="panel" style={{ padding: 60, textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Loading next batch…
        </p>
        {pageTotal > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {pageTotal} pending server-side
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Detection']}
        title="Review queue"
        sub={
          <>
            {pageTotal} pending
            {pageTotal > queue.length ? (
              <span style={{ color: 'var(--color-text-tertiary)' }}> · showing {queue.length} on this page</span>
            ) : null}
            {' · '}
            <span style={{ color: slaCount > 0 ? 'var(--color-text-danger)' : 'inherit' }}>{slaCount} over 4h SLA</span>
            {' · '}
            {fmtNaira(totalExposure)} total exposure
          </>
        }
      >
        <div style={{display:'flex', alignItems:'center', gap:8, marginRight:4, whiteSpace:'nowrap'}}>
          <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>Bulk</span>
          <div className={'toggle ' + (bulk ? 'on' : '')} onClick={()=>{ setBulk(b => !b); setSelected(new Set()); }}/>
        </div>
        <button
          onClick={() => {
            setSortOrder((s) => (s === 'newest' ? 'oldest' : 'newest'));
            setPage(1);
            setFocus(0);
          }}
          title={sortOrder === 'newest' ? 'Sort by oldest first' : 'Sort by newest first'}
        >
          <Ti name={sortOrder === 'oldest' ? 'sort-ascending' : 'sort-descending'} size={14} />
          {sortOrder === 'oldest' ? 'Oldest' : 'Newest'}
        </button>
        <button
          onClick={() => searchRef.current?.focus()}
          title="Filter by transaction / sender / receiver"
        >
          <Ti name="filter" size={14} />Filter
        </button>
        <button
          className="icon-only"
          title="Refresh"
          onClick={async () => {
            await refetchQueue();
            bumpCount();
            toast('Queue refreshed');
          }}
        >
          <Ti name="refresh" size={14} />
        </button>
      </PageHead>

      <div style={{display:'grid', gridTemplateColumns:'minmax(280px, 320px) minmax(0, 1fr)', gap:12, alignItems:'flex-start'}}>
        {/* LEFT — list */}
        <aside style={{background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)', borderRadius:'var(--border-radius-lg)', overflow:'hidden', display:'flex', flexDirection:'column', maxHeight:'calc(100vh - 140px)'}}>
          <div style={{padding:'10px 12px', borderBottom:'0.5px solid var(--color-border-tertiary)', background:'var(--color-background-secondary)', display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap'}}>
            <span style={{fontSize:10, fontWeight:500, letterSpacing:'0.06em', color:'var(--color-text-tertiary)'}}>PENDING&nbsp;·&nbsp;{filtered.length}</span>
            <span className="spacer"/>
            <span style={{fontSize:10, color:'var(--color-text-tertiary)', fontFamily:'var(--font-mono)'}}>{focus + 1}/{filtered.length}</span>
          </div>
          <div style={{padding:'8px 10px', borderBottom:'0.5px solid var(--color-border-tertiary)', display:'flex', gap:6}}>
            <SearchInput
              inputRef={searchRef}
              value={search}
              onCommit={(v) => {
                setSearch(v);
                setPage(1);
                setFocus(0);
              }}
              placeholder="Search /  txn, sender, receiver… (Enter)"
              hint="Press Enter — server-side"
            />
          </div>
          <div ref={listRef} style={{flex:1, overflow:'auto', minHeight:0}}>
            {filtered.map((row, i) => (
              <QueueCard
                key={row.auditId}
                row={row}
                focused={i === focus}
                bulk={bulk}
                checked={selected.has(row.auditId)}
                onCheck={() => setSelected(s => {
                  const n = new Set(s);
                  n.has(row.auditId) ? n.delete(row.auditId) : n.add(row.auditId);
                  return n;
                })}
                onClick={() => setFocus(i)}
              />
            ))}
          </div>
          <div style={{ padding: '6px 10px', borderTop: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
            <Pagination
              page={page}
              pageSize={QUEUE_PAGE_SIZE}
              total={pageTotal}
              onChange={(n) => {
                setPage(n);
                setSelected(new Set());
              }}
              variant="compact"
            />
          </div>
          {bulk && (
            <div style={{padding:'10px 12px', borderTop:'0.5px solid var(--color-border-tertiary)', background:'var(--color-background-secondary)', display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
              <span style={{fontSize:11, fontWeight:500}}>
                {selected.size} selected{visibleIds.length > 0 ? ` of ${visibleIds.length} visible` : ''}
              </span>
              <button
                onClick={allVisibleSelected ? clearSelection : selectAllVisible}
                style={{padding:'4px 8px', fontSize:11}}
                disabled={visibleIds.length === 0}
                title={allVisibleSelected ? 'Clear the selection' : 'Select every row currently visible'}
              >
                {allVisibleSelected ? 'Clear' : 'Select all'}
              </button>
              <span className="spacer"/>
              <button
                style={{padding:'4px 8px', fontSize:11}}
                disabled={selected.size === 0 || bulkRunning}
                onClick={() => setBulkAction('release')}
              >
                Release
              </button>
              <button
                className="danger-bg"
                style={{padding:'4px 8px', fontSize:11}}
                disabled={selected.size === 0 || bulkRunning}
                onClick={() => setBulkAction('confirm')}
              >
                Confirm
              </button>
            </div>
          )}
        </aside>

        {/* RIGHT — case file */}
        <main style={{minWidth:0}}>
          {current ? (
            <CaseFile
              current={current}
              similar={similar[current.auditId]}
              onConfirm={() => setOverrideOpen('confirm')}
              onRelease={() => setOverrideOpen('release')}
              onNeedInfo={() => setNeedInfoOpen(true)}
              onSkip={doSkip}
              onSimilarClick={(row) => setSimilarOpen(row)}
              nav={nav}
              toast={toast}
            />
          ) : (
            <div style={{padding:60, textAlign:'center', color:'var(--color-text-tertiary)', fontSize:13}}>No item selected</div>
          )}
        </main>
      </div>

      {/* Keyboard hint bar */}
      <div style={{display:'flex', alignItems:'center', gap:14, marginTop:12, padding:'10px 14px', background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)', borderRadius:'var(--border-radius-md)', fontSize:11, color:'var(--color-text-secondary)', flexWrap:'wrap'}}>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>J</kbd>/<kbd>K</kbd>Navigate</span>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>F</kbd>Confirm fraud</span>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>O</kbd>Override</span>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>N</kbd>Need info</span>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>S</kbd>Skip</span>
        <span style={{display:'inline-flex', alignItems:'center', gap:5}}><kbd>/</kbd>Search</span>
        <span className="spacer"/>
        <span style={{color:'var(--color-text-tertiary)'}}>You've handled <b style={{color:'var(--color-text-primary)'}}>{handledToday}</b> today</span>
      </div>

      {overrideOpen && (
        <OverrideModal
          kind={overrideOpen}
          current={current}
          onClose={()=>setOverrideOpen(null)}
          onSubmit={(reason) => overrideOpen === 'confirm' ? doConfirm(reason) : doRelease(reason)}
        />
      )}
      {needInfoOpen && (
        <NeedInfoModal current={current} onClose={()=>setNeedInfoOpen(false)} onSend={()=>{ setNeedInfoOpen(false); toast(`Follow-up sent · ${current.auditId} tagged needs-info`); }}/>
      )}
      {bulkAction && (
        <BulkOverrideModal
          kind={bulkAction}
          count={selected.size}
          running={bulkRunning}
          onClose={() => !bulkRunning && setBulkAction(null)}
          onSubmit={(reason) => doBulk(bulkAction, reason)}
        />
      )}
      {similarOpen && (
        <SimilarCaseModal
          row={similarOpen}
          onClose={() => setSimilarOpen(null)}
          onOpenTransaction={() => {
            const txnId = similarOpen.transactionId || similarOpen.id;
            if (txnId && nav) nav('txn:' + txnId);
            setSimilarOpen(null);
          }}
        />
      )}
    </>
  );
}

// ──────── List card ────────
function QueueCard({ row, focused, bulk, checked, onCheck, onClick }) {
  const tone = ageTone(row.ageMin);
  const isPreRule = row.stage === 'PRE_RULE';
  return (
    <div
      data-focused={focused ? '1' : '0'}
      onClick={onClick}
      style={{
        padding: '10px 12px',
        borderBottom: '0.5px solid var(--color-border-tertiary)',
        cursor: 'pointer',
        background: focused ? 'color-mix(in srgb, var(--color-background-info) 30%, transparent)' : 'transparent',
        borderLeft: focused ? '2px solid var(--color-text-info)' : '2px solid transparent',
        display: 'flex', gap: 8, alignItems: 'flex-start'
      }}
    >
      {bulk && (
        <div className={'checkbox ' + (checked ? 'checked' : '')} onClick={(e)=>{e.stopPropagation(); onCheck();}} style={{marginTop:2}}>
          {checked && <Ti name="check" size={10}/>}
        </div>
      )}
      <div style={{flex:1, minWidth:0}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:4}}>
          <span style={{fontSize:13, fontWeight:500}}>{fmtNaira(row.amount)}</span>
          {row.ageMin >= 240 && <span className="pill danger round" style={{padding:'1px 6px'}}>SLA</span>}
        </div>
        <p className="truncate" style={{margin:0, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--color-text-secondary)'}}>{truncId(row.transactionId, 16)}</p>
        <p className="truncate" style={{margin:'3px 0 0', fontSize:10, color:'var(--color-text-secondary)'}}>
          {isPreRule ? `PRE_RULE · ${row.preRule}` : row.reasonCodes.slice(0,2).join(' · ')}
        </p>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:5}}>
          <span style={{fontSize:10, fontWeight:500, color:`var(--color-text-${tone === 'sec' ? 'secondary' : tone})`}}>{fmtAge(row.ageMin)}</span>
          {isPreRule
            ? <span className="pill danger round">rule</span>
            : <span className={'pill round ' + (row.championScore >= 0.8 ? 'danger' : row.championScore >= 0.5 ? 'warn' : '')}>{row.championScore.toFixed(2)}</span>}
        </div>
      </div>
    </div>
  );
}

// ──────── Case file ────────
function CaseFile({ current, similar, onConfirm, onRelease, onNeedInfo, onSkip, onSimilarClick, nav, toast }) {
  const [fiaInput, setFiaInput] = useState('');
  const [fiaSending, setFiaSending] = useState(false);

  /**
   * Send a follow-up question to FIA. Requires an existing report for
   * this transaction; we call `requestReport` first which is idempotent
   * server-side (UNIQUE on transactionId + ON CONFLICT DO NOTHING) and
   * returns the existing report row when one exists. Then post the
   * message and navigate to the Transaction Detail page where the full
   * conversation history is rendered.
   */
  const sendFiaFollowup = async () => {
    const body = fiaInput.trim();
    if (!body || fiaSending) return;
    setFiaSending(true);
    try {
      const report = await requestReport(current.transactionId);
      const reportId = report?.id;
      if (!reportId) throw new Error('FIA did not return a report id');
      await postReportMessage(reportId, body);
      if (toast) toast('FIA follow-up sent — opening transaction view', 'success');
      setFiaInput('');
      if (nav && current.transactionId) nav('txn:' + current.transactionId);
    } catch (err) {
      if (toast) toast(`FIA unreachable · ${(err && err.message) || err}`, 'danger');
    } finally {
      setFiaSending(false);
    }
  };
  const isPreRule = current.stage === 'PRE_RULE';
  const top3 = current.reasonCodes.slice(0, 3).map((c, i) => ({ code: c, weight: current.reasonContribs[i] || 0.1 }));
  const maxW = Math.max(...top3.map(t => t.weight), 0.4);

  return (
    <div className="panel" style={{padding:'14px 16px'}}>
      {/* Header */}
      <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, marginBottom:12}}>
        <div style={{minWidth:0, flex:1}}>
          <p className="truncate" style={{margin:0, fontFamily:'var(--font-mono)', fontSize:11, color:'var(--color-text-secondary)'}}>{current.transactionId}</p>
          <p style={{margin:'4px 0 0', fontSize:20, fontWeight:500}}>{fmtNaira(current.amount)}</p>
          <p className="truncate" style={{margin:'2px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>
            {current.sender} → {current.receiver} · {current.txnType} · {fmtAge(current.ageMin)} ago
          </p>
          <p style={{margin:'2px 0 0', fontSize:11, color:'var(--color-text-tertiary)'}}>
            segment <span className="mono" style={{color:'var(--color-text-secondary)'}}>{current.segment}</span>
          </p>
        </div>
        <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0}}>
          <span className="pill verdict danger">DECLINE · {isPreRule ? 'RULE' : 'ML'}</span>
          <span className="mono" style={{fontSize:10, color:'var(--color-text-tertiary)'}}>{current.auditId}</span>
        </div>
      </div>

      {/* Score tiles */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:12}}>
        <div className="tile">
          <p className="label-up" style={{margin:0}}>SCORE</p>
          <p style={{margin:'2px 0 0', fontSize:14, fontWeight:500, color: isPreRule ? 'var(--color-text-tertiary)' : (current.championScore > 0.65 ? 'var(--color-text-danger)' : 'var(--color-text-primary)')}}>
            {isPreRule ? '—' : current.championScore.toFixed(2)}
          </p>
        </div>
        <div className="tile">
          <p className="label-up" style={{margin:0}}>THRESHOLD</p>
          <p style={{margin:'2px 0 0', fontSize:14, fontWeight:500}}>{current.threshold.toFixed(2)}</p>
        </div>
        <div className="tile">
          <p className="label-up" style={{margin:0}}>SHADOW</p>
          <p style={{margin:'2px 0 0', fontSize:14, fontWeight:500, color:'var(--color-text-warning)'}}>{isPreRule || current.shadowScore == null ? '—' : current.shadowScore.toFixed(2)}</p>
        </div>
        <div className="tile">
          <p className="label-up" style={{margin:0}}>MODEL</p>
          <p style={{margin:'2px 0 0', fontSize:12, fontWeight:500, fontFamily:'var(--font-mono)'}}>{current.modelVersion}</p>
        </div>
      </div>

      {/* Reason codes */}
      <p style={{margin:'0 0 6px', fontSize:11, color:'var(--color-text-secondary)'}}>{isPreRule ? 'Rule fired' : 'Top reason codes'}</p>
      {isPreRule ? (
        <div style={{display:'flex', alignItems:'center', gap:8, padding:'9px 12px', background:'var(--color-background-danger)', borderRadius:'var(--border-radius-md)', marginBottom:12, fontSize:12}}>
          <Ti name="shield-x" size={14} style={{color:'var(--color-text-danger)'}}/>
          <span className="mono" style={{color:'var(--color-text-danger)', fontWeight:500}}>{current.preRule}</span>
          <span style={{color:'var(--color-text-secondary)'}}>· PRE-stage short-circuit · no ML inference performed</span>
        </div>
      ) : (
        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:12}}>
          {top3.map((t, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'130px 1fr 44px', gap:8, alignItems:'center'}}>
              <span style={{fontSize:10, fontFamily:'var(--font-mono)'}}>{t.code}</span>
              <div style={{height:4, background:'var(--color-background-secondary)', borderRadius:2, overflow:'hidden'}}>
                <div style={{height:'100%', width: Math.max(8, (t.weight / maxW) * 100) + '%', background:'var(--color-text-danger)'}}/>
              </div>
              <span style={{fontSize:10, textAlign:'right', color:'var(--color-text-danger)', fontWeight:500}}>+{t.weight.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* FIA */}
      <div style={{padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', marginBottom:10}}>
        <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:6}}>
          <Ti name="robot" size={13} style={{color:'var(--color-text-info)', flexShrink:0}}/>
          <span style={{fontSize:11, fontWeight:500, whiteSpace:'nowrap'}}>FIA verdict</span>
          <span className={'pill round ' + (current.fia.verdict === 'FRAUD_CONFIRMED' ? 'danger' : 'warn')} style={{flexShrink:0}}>{current.fia.verdict}</span>
          <span style={{fontSize:10, color:'var(--color-text-tertiary)', whiteSpace:'nowrap'}}>conf&nbsp;{current.fia.confidence}</span>
          <span className="spacer"/>
          <span style={{fontSize:10, fontFamily:'var(--font-mono)', color:'var(--color-text-tertiary)', whiteSpace:'nowrap'}}>phi-3-mini-v1</span>
        </div>
        <p style={{margin:0, fontSize:11.5, color:'var(--color-text-secondary)', lineHeight:1.55}}>{current.fia.narrative}</p>
        <div style={{marginTop:8, display:'flex', gap:6}}>
          <input
            placeholder="Ask FIA a follow-up question…"
            value={fiaInput}
            onChange={(e) => setFiaInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fiaInput.trim() && !fiaSending) {
                sendFiaFollowup();
              }
            }}
            disabled={fiaSending}
            style={{flex:1, minWidth:0, fontSize:11, padding:'5px 9px'}}
          />
          <button
            style={{fontSize:11, padding:'5px 10px'}}
            disabled={!fiaInput.trim() || fiaSending}
            onClick={sendFiaFollowup}
          >
            {fiaSending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>

      {/* Similar cases — audit rows sharing sender or receiver. */}
      <div style={{padding:'10px 12px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', marginBottom:14}}>
        <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:6, whiteSpace:'nowrap'}}>
          <Ti name="affiliate" size={13} style={{color:'var(--color-text-secondary)', flexShrink:0}}/>
          <span style={{fontSize:11, fontWeight:500}}>Similar cases</span>
          <span style={{fontSize:10, color:'var(--color-text-tertiary)'}}>· same sender or receiver</span>
        </div>
        {similar == null ? (
          <p style={{margin:'4px 0 0', fontSize:11, color:'var(--color-text-tertiary)'}}>Loading…</p>
        ) : similar.length === 0 ? (
          <p style={{margin:'4px 0 0', fontSize:11, color:'var(--color-text-tertiary)'}}>No similar cases for this sender or receiver.</p>
        ) : (
          <>
            <div className="row-grid header" style={{gridTemplateColumns:'80px 1fr 60px 60px', padding:'calc(var(--row-pad-y, 9px) * 0.5) 0', borderBottom:'0.5px solid var(--color-border-tertiary)'}}>
              <span>AUDIT</span><span>FLOW</span><span>WHEN</span><span></span>
            </div>
            {similar.map((s) => {
              const ageMin = s.createdAt ? Math.max(0, Math.round((Date.now() - new Date(s.createdAt).getTime()) / 60000)) : null;
              const decision = s.overrideDecision || s.finalDecision || '—';
              const tone = decision === 'DECLINE' ? 'danger' : decision === 'ACCEPT' ? 'success' : 'warn';
              const onOpen = () => onSimilarClick && onSimilarClick(s);
              return (
                <div
                  key={s.id || s.auditId}
                  className="row-grid hoverable"
                  role="button"
                  tabIndex={0}
                  onClick={onOpen}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
                  }}
                  style={{
                    gridTemplateColumns: '80px 1fr 60px 60px',
                    padding: 'calc(var(--row-pad-y, 9px) * 0.7) 6px',
                    fontSize: 11,
                  }}
                  title="Open transaction details"
                >
                  <span className="mono" style={{color:'var(--color-text-secondary)'}}>{truncId(s.id || s.auditId || '', 10)}</span>
                  <span className="truncate" style={{color:'var(--color-text-secondary)'}}>{(s.senderId || '—') + ' → ' + (s.receiverId || '—')}</span>
                  <span style={{color:'var(--color-text-tertiary)'}}>{ageMin == null ? '—' : fmtAge(ageMin)}</span>
                  <span className={'pill ' + tone + ' round'} style={{justifySelf:'start'}}>{decision.toLowerCase()}</span>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Actions */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6}}>
        <button onClick={onConfirm} className="danger-bg" style={{padding:'10px 6px', display:'flex', flexDirection:'column', gap:3}}>
          <Ti name="shield-x" size={16}/>
          <span style={{fontSize:11}}>Confirm fraud</span>
          <kbd style={{fontSize:9}}>F</kbd>
        </button>
        <button onClick={onRelease} style={{padding:'10px 6px', display:'flex', flexDirection:'column', gap:3}}>
          <Ti name="circle-check" size={16}/>
          <span style={{fontSize:11}}>Release</span>
          <kbd style={{fontSize:9}}>O</kbd>
        </button>
        <button onClick={onNeedInfo} style={{padding:'10px 6px', display:'flex', flexDirection:'column', gap:3}}>
          <Ti name="help-circle" size={16}/>
          <span style={{fontSize:11}}>Need info</span>
          <kbd style={{fontSize:9}}>N</kbd>
        </button>
        <button onClick={onSkip} style={{padding:'10px 6px', display:'flex', flexDirection:'column', gap:3}}>
          <Ti name="player-skip-forward" size={16}/>
          <span style={{fontSize:11}}>Skip</span>
          <kbd style={{fontSize:9}}>S</kbd>
        </button>
      </div>
    </div>
  );
}

function EmptyQueue({ handledToday, onRefresh }) {
  return (
    <>
      <PageHead crumbs={['Dashboard','Detection']} title="Review queue" sub="No declined transactions awaiting analyst review.">
        <button onClick={onRefresh}><Ti name="refresh" size={14}/>Refresh</button>
      </PageHead>
      <div style={{display:'flex', alignItems:'center', justifyContent:'center', padding:80}}>
        <div className="panel" style={{maxWidth:380, textAlign:'center', padding:'28px 28px 22px'}}>
          <div style={{width:48, height:48, margin:'0 auto 14px', borderRadius:'50%', background:'var(--color-background-success)', color:'var(--color-text-success)', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
            <Ti name="check" size={20}/>
          </div>
          <h3 style={{margin:'0 0 4px', fontSize:16, fontWeight:500}}>Queue clear</h3>
          <p style={{margin:0, fontSize:12, color:'var(--color-text-secondary)'}}>Nothing pending review right now.</p>
          <div style={{marginTop:16, paddingTop:12, borderTop:'0.5px solid var(--color-border-tertiary)', fontSize:11, color:'var(--color-text-tertiary)'}}>
            You handled <b style={{color:'var(--color-text-primary)'}}>{handledToday}</b> reviews today.
          </div>
        </div>
      </div>
    </>
  );
}

// ──────── Modals ────────
function OverrideModal({ kind, current, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const isConfirm = kind === 'confirm';
  return (
    <Modal
      title={isConfirm ? 'Confirm as fraud' : 'Release transaction'}
      sub={isConfirm
        ? <>Writes <code className="mono">fraudLabel = true</code> on the txn so MLA picks it up at next drift loop. Fires <code className="mono">decision.overridden</code>.</>
        : <>Writes <code className="mono">overrideDecision = "ACCEPT"</code> on the audit row. Fires <code className="mono">decision.overridden</code>.</>}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className={isConfirm ? 'danger-bg' : 'success-bg'} disabled={!reason.trim()} onClick={()=>onSubmit(reason)}>
          {isConfirm ? 'Confirm fraud' : 'Release'}
        </button>
      </>}
    >
      <div style={{padding:'8px 10px', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', marginBottom:12, fontSize:12}}>
        <span className="mono" style={{fontSize:11, color:'var(--color-text-secondary)'}}>{current.auditId}</span>
        <span style={{marginLeft:8, fontWeight:500}}>{fmtNaira(current.amount)}</span>
        <span style={{marginLeft:8, color:'var(--color-text-secondary)'}}>{current.sender} → {current.receiver}</span>
      </div>
      <label className="label-up" style={{display:'block', marginBottom:6}}>Reason <span style={{color:'var(--color-text-danger)'}}>*</span></label>
      <textarea
        value={reason}
        onChange={e=>setReason(e.target.value)}
        autoFocus
        rows={3}
        placeholder={isConfirm ? 'e.g. confirmed mule cluster cluster_2310-vpn-burst' : 'e.g. customer confirmed via callback at 14:22'}
        style={{width:'100%', resize:'vertical'}}
      />
      <p style={{margin:'8px 0 0', fontSize:11, color:'var(--color-text-tertiary)'}}>Stored in <code className="mono">decisionAuditLog.overrideReason</code>.</p>
    </Modal>
  );
}

function NeedInfoModal({ current, onClose, onSend }) {
  const [msg, setMsg] = useState('Re-check the device fingerprint against case INV-04812 — was there a match?');
  return (
    <Modal
      title="Ask FIA for more info"
      sub={<>Posts to <code className="mono">/v1/reports/:id/messages</code>. Item stays in queue with a <code className="mono">needs-info</code> tag.</>}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={()=>onSend(msg)}>Send to FIA</button>
      </>}
    >
      <textarea autoFocus value={msg} onChange={e=>setMsg(e.target.value)} rows={4} style={{width:'100%', resize:'vertical'}}/>
    </Modal>
  );
}

/**
 * Capture a shared reason for a bulk Confirm / Release. The submit
 * button is disabled until the reason is non-blank — every override
 * gets the same rationale logged to `decisionAuditLog.overrideReason`.
 */
function BulkOverrideModal({ kind, count, running, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const isConfirm = kind === 'confirm';
  return (
    <Modal
      title={isConfirm ? `Confirm ${count} item${count === 1 ? '' : 's'} as fraud` : `Release ${count} item${count === 1 ? '' : 's'}`}
      sub={
        isConfirm ? (
          <>
            Writes <code className="mono">fraudLabel = true</code> on each
            selected transaction so MLA picks them up at the next drift
            loop. Fires <code className="mono">decision.overridden</code>
            per row.
          </>
        ) : (
          <>
            Writes <code className="mono">overrideDecision = "ACCEPT"</code>
            on each selected audit row. Fires{' '}
            <code className="mono">decision.overridden</code> per row.
          </>
        )
      }
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={running}>Cancel</button>
          <button
            className={isConfirm ? 'danger-bg' : 'success-bg'}
            disabled={!reason.trim() || running}
            onClick={() => onSubmit(reason.trim())}
          >
            {running
              ? `Applying to ${count}…`
              : isConfirm
                ? `Confirm ${count}`
                : `Release ${count}`}
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        The same reason is recorded against every selected row.
      </p>
      <label className="label-up" style={{ display: 'block', marginBottom: 6 }}>
        Reason <span style={{ color: 'var(--color-text-danger)' }}>*</span>
      </label>
      <textarea
        autoFocus
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={
          isConfirm
            ? 'e.g. confirmed mule cluster cluster_2310-vpn-burst'
            : 'e.g. customer confirmed via callback at 14:22'
        }
        style={{ width: '100%', resize: 'vertical' }}
      />
      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        Stored in <code className="mono">decisionAuditLog.overrideReason</code> on every row.
      </p>
    </Modal>
  );
}

function parseErr(err) {
  const m = String(err?.message || err);
  const bodyStart = m.indexOf('{');
  if (bodyStart >= 0) {
    try {
      const obj = JSON.parse(m.slice(bodyStart));
      if (obj && typeof obj.message === 'string') return obj.message;
    } catch {
      /* fallthrough */
    }
  }
  return m;
}

/**
 * Lightweight detail modal for a similar-case row. The list endpoint
 * already returns the full audit payload, so we render that directly
 * rather than re-fetching. "Open transaction" jumps to the full
 * Transaction Detail page for the richer view.
 */
function SimilarCaseModal({ row, onClose, onOpenTransaction }) {
  const decision = row.overrideDecision || row.finalDecision || '—';
  const tone = decision === 'DECLINE' ? 'danger' : decision === 'ACCEPT' ? 'success' : 'warn';
  const score = row.championScore == null ? null : Number(row.championScore);
  const shadow = row.shadowScore == null ? null : Number(row.shadowScore);
  const threshold = row.threshold == null ? null : Number(row.threshold);
  const amount = row.amount == null ? null : Number(row.amount);
  const reasons = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
  return (
    <Modal
      title="Similar case"
      sub={<span className="mono" style={{fontSize:11}}>{row.transactionId || row.id || row.auditId}</span>}
      onClose={onClose}
      width={520}
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="info-bg" onClick={onOpenTransaction} disabled={!row.transactionId && !row.id}>
          <Ti name="external-link" size={12}/>Open transaction
        </button>
      </>}
    >
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, fontSize:12}}>
        <Kv label="Decision">
          <span className={'pill ' + tone + ' round'}>{decision}</span>
          {row.overrideDecision && (
            <span style={{marginLeft:6, fontSize:10, color:'var(--color-text-tertiary)'}}>(overridden)</span>
          )}
        </Kv>
        <Kv label="Amount">{amount == null ? '—' : fmtNaira(amount)}</Kv>
        <Kv label="Sender">
          <code className="mono truncate" style={{fontSize:11}}>{row.senderId || '—'}</code>
        </Kv>
        <Kv label="Receiver">
          <code className="mono truncate" style={{fontSize:11}}>{row.receiverId || '—'}</code>
        </Kv>
        <Kv label="Score">{score == null ? '—' : score.toFixed(3)}</Kv>
        <Kv label="Threshold">{threshold == null ? '—' : threshold.toFixed(3)}</Kv>
        <Kv label="Shadow">{shadow == null ? '—' : shadow.toFixed(3)}</Kv>
        <Kv label="Model">
          <code className="mono" style={{fontSize:11}}>{row.championModelVersion || '—'}</code>
        </Kv>
        <Kv label="Segment">{row.segment || '—'}</Kv>
        <Kv label="Source">{row.decisionSource || '—'}</Kv>
        <Kv label="When">{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</Kv>
        <Kv label="Audit ID">
          <code className="mono" style={{fontSize:10}}>{truncId(row.id || row.auditId || '', 16)}</code>
        </Kv>
      </div>
      {reasons.length > 0 && (
        <div style={{marginTop:12, paddingTop:10, borderTop:'0.5px solid var(--color-border-tertiary)'}}>
          <p className="label-up" style={{margin:'0 0 6px'}}>REASON CODES</p>
          <div style={{display:'flex', flexWrap:'wrap', gap:4}}>
            {reasons.map((r, i) => {
              const code = typeof r === 'string' ? r : r?.code || '';
              return code ? (
                <span key={code + i} className="mono" style={{fontSize:10, background:'var(--color-background-secondary)', padding:'2px 6px', borderRadius:4}}>
                  {code}
                </span>
              ) : null;
            })}
          </div>
        </div>
      )}
      {row.overrideReason && (
        <div style={{marginTop:12, paddingTop:10, borderTop:'0.5px solid var(--color-border-tertiary)'}}>
          <p className="label-up" style={{margin:'0 0 6px'}}>OVERRIDE REASON</p>
          <p style={{margin:0, fontSize:12, color:'var(--color-text-secondary)'}}>{row.overrideReason}</p>
        </div>
      )}
    </Modal>
  );
}

function Kv({ label, children }) {
  return (
    <div style={{minWidth:0}}>
      <p className="label-up" style={{margin:'0 0 3px'}}>{label}</p>
      <div className="truncate" style={{fontSize:12}}>{children}</div>
    </div>
  );
}

export default ReviewQueue;
