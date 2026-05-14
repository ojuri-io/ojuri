// Audit log — explorer with filters and export
//
// Wired to `GET /v1/admin/audit` (filters: from / to / decision / model /
// reasonCodes / search / overridden / pending / limit / offset). Filters
// edit *draft* state inside the panel; the row fetch only fires when the
// user hits "Apply" or presses Enter inside the search input. Falls back
// to the synthetic mock list when the backend is unreachable.

import React, { useState, useMemo, useEffect } from 'react';
import { Ti, PageHead, fmtNaira, truncId } from '../components/shell.jsx';
import { SearchInput, DateRangeFilter } from '../components/search-input.jsx';
import { listAuditRows, listReasonCodes } from '../api/client.js';

const PER_PAGE = 12;
// Fallback catalogue used only when /v1/admin/audit/reason-codes hasn't
// returned yet — the live list overrides it on mount.
const REASON_OPTIONS_FALLBACK = [];

// Translate a server row into the table view model. Tolerant about field
// names because the backend may have renamed some columns since the demo
// dataset shipped.
//
// `reasonCodes` from the live API is an array of objects
//   [{ code, value, contribution, description }, …]
// — flatten to a string array so the table can render `<span>{r}</span>`
// without React throwing "Objects are not valid as a React child". The
// score / amount fields tolerate pg-numeric strings too.
function normaliseRow(r) {
  const score = r.championScore ?? r.score ?? null;
  const decision = r.overrideDecision || r.finalDecision || r.decision || 'ACCEPT';
  const rawReasons = Array.isArray(r.reasonCodes)
    ? r.reasonCodes
    : Array.isArray(r.reasons)
    ? r.reasons
    : [];
  const reasons = rawReasons.map((c) => (typeof c === 'string' ? c : c?.code || '')).filter(Boolean);
  return {
    id: r.transactionId || r.id || '',
    auditId: r.auditId || r.id || '',
    time: r.createdAt
      ? new Date(r.createdAt).toLocaleTimeString('en-GB', { hour12: false })
      : '',
    amount: Number(r.amount ?? 0),
    score: score == null ? null : Number(score),
    decision,
    overridden: !!r.overrideDecision || !!r.overridden,
    reasons,
  };
}

function AuditLog({ toast, nav, queue, rules, fromTweak, toTweak }) {
  // Committed (applied) filters — drive the fetch.
  const [filters, setFilters] = useState({
    from: fromTweak || '',
    to: toTweak || '',
    search: '',
    decisions: new Set(['ACCEPT', 'DECLINE', 'REVIEW']),
    model: '',
    reasonFilters: new Set(),
    overridden: false,
    pending: false,
  });
  // Draft state — what the user is currently editing in the panel.
  const [draftDecisions, setDraftDecisions] = useState(new Set(['ACCEPT', 'DECLINE', 'REVIEW']));
  const [draftModel, setDraftModel] = useState('');
  const [draftReasonFilters, setDraftReasonFilters] = useState(new Set());
  const [draftFlags, setDraftFlags] = useState({ overridden: false, pending: false });

  const [page, setPage] = useState(1);
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queryMs, setQueryMs] = useState(0);
  // Collapsible filters panel. Sticky per browser so analysts who
  // routinely work with the filters closed don't have to dismiss it
  // on every page visit. Default = open so first-timers see it.
  const [filtersOpen, setFiltersOpen] = useState(() => {
    try {
      const v = localStorage.getItem('sentinel.audit.filtersOpen');
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('sentinel.audit.filtersOpen', filtersOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [filtersOpen]);
  const [reasonOptions, setReasonOptions] = useState(REASON_OPTIONS_FALLBACK);

  // Hydrate reason-code chips from the live catalogue. One-shot on mount.
  useEffect(() => {
    let cancelled = false;
    listReasonCodes()
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const codes = rows.map((r) => (typeof r === 'string' ? r : r.code)).filter(Boolean);
        if (codes.length) setReasonOptions(codes);
      })
      .catch(() => {
        /* leave the fallback empty list — Apply still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep state in sync with the Tweaks defaults when they change. We push
  // the value into both filters (applied) and the local panel draft so the
  // first render shows them already lit up.
  useEffect(() => {
    if (fromTweak) setFilters((f) => ({ ...f, from: fromTweak }));
  }, [fromTweak]);
  useEffect(() => {
    if (toTweak) setFilters((f) => ({ ...f, to: toTweak }));
  }, [toTweak]);

  // Fetch only when a committed filter, page, or search changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setForbidden(false);
    const started = Date.now();
    const fetchFilters = {
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
      search: filters.search || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      // Send the filter only when it actually narrows the result —
      // "all 3 selected" is equivalent to "no filter". Was hardcoded
      // to <4 (off-by-one) which silently dropped REVIEW rows.
      decision: filters.decisions.size > 0 && filters.decisions.size < 3 ? [...filters.decisions] : undefined,
      modelVersion: filters.model || undefined,
      reasonCodes: filters.reasonFilters.size > 0 ? [...filters.reasonFilters] : undefined,
      overridden: filters.overridden || undefined,
      pending: filters.pending || undefined,
    };
    listAuditRows(fetchFilters)
      .then((res) => {
        if (cancelled) return;
        setQueryMs(Date.now() - started);
        if (Array.isArray(res?.rows)) {
          setRows(res.rows.map(normaliseRow));
          setTotal(res.total ?? res.rows.length);
          setUsedFallback(false);
        } else {
          setRows(null);
          setUsedFallback(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (String(err?.message || '').startsWith('403')) setForbidden(true);
        setRows(null);
        setUsedFallback(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page]);

  // Synthetic fallback set built from `queue` + a handful of overridden/review
  // rows, used when the API call falls back.
  const fallbackRows = useMemo(() => buildAuditRows(queue), [queue]);

  const localFiltered = useMemo(() => {
    let list = fallbackRows;
    if (filters.decisions.size > 0 && filters.decisions.size < 4) {
      list = list.filter((r) => filters.decisions.has(r.decision));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(
        (r) =>
          (r.id || '').toLowerCase().includes(q) ||
          (r.reasons || []).join(' ').toLowerCase().includes(q),
      );
    }
    if (filters.reasonFilters.size > 0) {
      list = list.filter((r) => (r.reasons || []).some((rc) => filters.reasonFilters.has(rc)));
    }
    if (filters.overridden) list = list.filter((r) => r.overridden);
    return list;
  }, [fallbackRows, filters]);

  // Summary shown next to the chevron when the panel is collapsed.
  // `activeCount` drives the badge; `activeFilterSummary` is the
  // inline preview so analysts can tell at a glance whether the
  // current view is filtered without expanding.
  const { activeCount, activeFilterSummary } = useMemo(() => {
    const parts = [];
    const allDecisions = filters.decisions.size === 0 || filters.decisions.size >= 3;
    if (filters.from || filters.to) {
      parts.push(`Date ${filters.from || '…'} → ${filters.to || 'now'}`);
    }
    if (filters.search) parts.push(`"${filters.search}"`);
    if (!allDecisions) parts.push(`Decision: ${[...filters.decisions].join(', ')}`);
    if (filters.model) parts.push(`Model: ${filters.model}`);
    if (filters.reasonFilters.size > 0) parts.push(`Reasons: ${filters.reasonFilters.size}`);
    if (filters.overridden) parts.push('Overridden');
    if (filters.pending) parts.push('Pending');
    return { activeCount: parts.length, activeFilterSummary: parts.join(' · ') };
  }, [filters]);

  const apply = () => {
    setFilters((f) => ({
      ...f,
      decisions: new Set(draftDecisions),
      model: draftModel,
      reasonFilters: new Set(draftReasonFilters),
      overridden: draftFlags.overridden,
      pending: draftFlags.pending,
    }));
    setPage(1);
    toast(`Filters applied · query ${queryMs}ms`);
  };

  const reset = () => {
    setDraftDecisions(new Set(['ACCEPT', 'DECLINE', 'REVIEW']));
    setDraftModel('');
    setDraftReasonFilters(new Set());
    setDraftFlags({ overridden: false, pending: false });
    // Clear the *committed* filter set entirely — including `from`/`to`
    // and `search`, which weren't being touched before. Without this
    // any date range pushed in via Tweaks (or a stale one from a prior
    // session) silently kept the result set empty after a "Reset".
    setFilters({
      from: '',
      to: '',
      search: '',
      decisions: new Set(['ACCEPT', 'DECLINE', 'REVIEW']),
      model: '',
      reasonFilters: new Set(),
      overridden: false,
      pending: false,
    });
    setPage(1);
    toast('Filters reset');
  };

  const toggleDecision = (d) => {
    setDraftDecisions((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });
  };
  const toggleReason = (r) => {
    setDraftReasonFilters((s) => {
      const n = new Set(s);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });
  };

  const displayRows = rows && !usedFallback ? rows : localFiltered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const displayTotal = rows && !usedFallback ? total : localFiltered.length;
  const totalPages = Math.max(1, Math.ceil(displayTotal / PER_PAGE));

  if (forbidden) {
    return (
      <>
        <PageHead crumbs={['Dashboard', 'Insights']} title="Audit log" sub="Forbidden" />
        <div className="panel" style={{ padding: 36, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
          You don't have access to this view. Requires <code className="mono">audit:read</code>.
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead crumbs={['Dashboard', 'Insights']} title="Audit log" sub="Every decision Sentinel has ever made · immutable, append-only">
        <button><Ti name="bookmark" size={14} />Save query</button>
      </PageHead>

      {/* Filters — collapsible. Default state is sticky per browser
          via localStorage so analysts who like the panel closed don't
          have to dismiss it on every visit. */}
      <section className="panel" style={{ marginBottom: 12, padding: filtersOpen ? undefined : '8px 14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
            marginBottom: filtersOpen ? 10 : 0,
          }}
          onClick={() => setFiltersOpen((v) => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFiltersOpen((v) => !v); }
          }}
          aria-expanded={filtersOpen}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Ti name={filtersOpen ? 'chevron-down' : 'chevron-right'} size={14} />
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Filters</h2>
            {activeCount > 0 && (
              <span className="pill info" style={{ fontSize: 9, padding: '1px 6px' }}>
                {activeCount} active
              </span>
            )}
            {!filtersOpen && activeFilterSummary && (
              <span
                className="truncate"
                style={{ fontSize: 11, color: 'var(--color-text-tertiary)', minWidth: 0 }}
              >
                {activeFilterSummary}
              </span>
            )}
          </div>
          {!filtersOpen && activeCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              style={{ fontSize: 11, padding: '3px 8px' }}
              title="Clear every filter"
            >
              <Ti name="x" size={11} />Reset
            </button>
          )}
        </div>

        {filtersOpen && <>
        <DateRangeFilter
          from={filters.from}
          to={filters.to}
          onApply={({ from, to }) => {
            setFilters((f) => ({ ...f, from, to }));
            setPage(1);
          }}
          onReset={() => {
            setFilters((f) => ({ ...f, from: '', to: '' }));
            setPage(1);
          }}
          inline={false}
        />

        <div style={{ marginBottom: 10 }}>
          <p className="label-up" style={{ margin: '0 0 4px' }}>TRANSACTION, SENDER, OR RECEIVER ID</p>
          <SearchInput
            value={filters.search}
            onCommit={(v) => {
              setFilters((f) => ({ ...f, search: v }));
              setPage(1);
            }}
            placeholder="UUID, partial ID, or user handle… (press Enter)"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <p className="label-up" style={{ margin: '0 0 4px' }}>DECISION</p>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['ACCEPT', 'DECLINE', 'REVIEW', 'OVERRIDDEN'].map((d) => (
                <button
                  key={d}
                  className={draftDecisions.has(d) ? (d === 'ACCEPT' ? 'success-bg' : d === 'DECLINE' ? 'danger-bg' : 'info-bg') : ''}
                  onClick={() => toggleDecision(d)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="label-up" style={{ margin: '0 0 4px' }}>MODEL VERSION</p>
            <select className="mono" value={draftModel} onChange={(e) => setDraftModel(e.target.value)} style={{ width: '100%', fontSize: 12 }}>
              <option value="">All versions</option>
              <option value="v1.2.0">v1.2.0 (shadow)</option>
              <option value="v1.1.0">v1.1.0 (active)</option>
              <option value="v1.0.0">v1.0.0 (retired)</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <p className="label-up" style={{ margin: '0 0 4px' }}>REASON CODES</p>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {reasonOptions.length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No reason codes registered yet.</span>
            )}
            {reasonOptions.slice(0, 5).map((r) => (
              <button
                key={r}
                className={draftReasonFilters.has(r) ? 'info-bg' : ''}
                onClick={() => toggleReason(r)}
                style={{ fontSize: 11, padding: '3px 7px', fontFamily: 'var(--font-mono)' }}
              >
                {r}
              </button>
            ))}
            {reasonOptions.length > 5 && (
              <button style={{ fontSize: 11, padding: '3px 7px', color: 'var(--color-text-secondary)', borderColor: 'transparent' }}>+ {reasonOptions.length - 5} more</button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTop: '0.5px solid var(--color-border-tertiary)', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Checkbox checked={draftFlags.overridden} onChange={() => setDraftFlags((f) => ({ ...f, overridden: !f.overridden }))}>Was overridden</Checkbox>
            <Checkbox checked={draftFlags.pending} onChange={() => setDraftFlags((f) => ({ ...f, pending: !f.pending }))}>Pending review</Checkbox>
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Search commits on Enter; chips and date range commit on Apply.</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={reset}>Reset</button>
            <button className="info-bg" onClick={apply} disabled={loading}>{loading ? 'Applying…' : 'Apply'}</button>
          </div>
        </div>
        </>}
      </section>

      {/* Results */}
      <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>{displayTotal} rows matched · query {queryMs || '—'}ms{usedFallback ? ' · (mock fallback)' : ''}</p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => toast('CSV exported · ' + displayTotal + ' rows')}><Ti name="file-type-csv" size={12} />CSV</button>
            <button style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => toast('JSON exported · ' + displayTotal + ' rows')}><Ti name="braces" size={12} />JSON</button>
          </div>
        </div>

        <div className="row-grid header" style={{ gridTemplateColumns: '80px 1.4fr 1fr 70px 80px 1fr 24px', padding: 'calc(var(--row-pad-y, 9px) * 0.7) 14px', background: 'var(--color-background-secondary)' }}>
          <span>WHEN</span><span>TRANSACTION</span><span>AMOUNT</span><span>SCORE</span><span>DECISION</span><span>REASONS</span><span></span>
        </div>
        {loading && displayRows.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
        )}
        {!loading && displayRows.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No audit rows match these filters.</div>
        )}
        {displayRows.map((r, i) => {
          // `r.id` is the transactionId (per normaliseAuditRow); the
          // detail route is keyed on that. When it's missing we render
          // the row non-clickable rather than navigating to nowhere.
          const txnId = r.id || r.transactionId;
          const navigable = !!(nav && txnId);
          const onRowClick = navigable ? () => nav('txn:' + txnId) : undefined;
          return (
            <div
              key={r.auditId || i}
              className={navigable ? 'row-grid hoverable' : 'row-grid'}
              role={navigable ? 'button' : undefined}
              tabIndex={navigable ? 0 : undefined}
              onClick={onRowClick}
              onKeyDown={
                navigable
                  ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(); } }
                  : undefined
              }
              style={{
                gridTemplateColumns: '80px 1.4fr 1fr 70px 80px 1fr 24px',
                padding: 'var(--row-pad-y, 9px) 14px',
                cursor: navigable ? 'pointer' : 'default',
                background: r.overridden ? 'color-mix(in srgb, var(--color-background-warning) 12%, transparent)' : 'transparent',
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{r.time}</span>
              <code className="mono truncate" style={{ fontSize: 10 }}>{truncId(r.id, 16)}</code>
              <span style={{ fontSize: 12 }}>{fmtNaira(r.amount)}</span>
              <span className={'pill round ' + scoreTone(r.score)} style={{ justifySelf: 'start' }}>{r.score == null ? '—' : r.score.toFixed(2)}</span>
              <span className={'pill ' + decisionTone(r.decision)} style={{ justifySelf: 'start', padding: '2px 7px' }}>
                {r.decision}{r.overridden && <Ti name="arrows-shuffle" size={10} style={{ marginLeft: 3 }} />}
              </span>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', minWidth: 0 }}>
                {(r.reasons || []).slice(0, 2).map((rc, ri) => {
                  const code = typeof rc === 'string' ? rc : rc?.code || '';
                  return (
                    <span key={code || ri} style={{ fontSize: 9, background: 'var(--color-background-secondary)', padding: '1px 5px', borderRadius: 6, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{code}</span>
                  );
                })}
              </div>
              {navigable
                ? <Ti name="arrow-right" size={12} style={{ color: 'var(--color-text-tertiary)', justifySelf: 'end' }} />
                : <span />}
            </div>
          );
        })}
      </section>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 4px 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>
        <span>Showing {Math.min((page - 1) * PER_PAGE + 1, displayTotal)}–{Math.min(page * PER_PAGE, displayTotal)} of {displayTotal}</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button style={{ fontSize: 11, padding: '4px 8px', minWidth: 28 }} disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><Ti name="chevron-left" size={12} /></button>
          <span style={{ fontSize: 11, padding: '0 6px' }}>{page} / {totalPages}</span>
          <button style={{ fontSize: 11, padding: '4px 8px', minWidth: 28 }} disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><Ti name="chevron-right" size={12} /></button>
        </div>
      </div>
    </>
  );
}

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

function scoreTone(s) {
  if (s == null) return '';
  if (s >= 0.65) return 'danger';
  if (s >= 0.4) return 'warn';
  return 'success';
}
function decisionTone(d) {
  if (d === 'DECLINE') return 'danger';
  if (d === 'ACCEPT') return 'success';
  if (d === 'REVIEW') return 'warn';
  return '';
}

function buildAuditRows(queue) {
  const base = queue.map((q) => ({
    id: q.transactionId,
    auditId: q.auditId,
    time: ['14:21:08', '13:58:42', '13:31:19', '12:47:55', '11:58:03', '11:19:47', '10:52:14', '10:11:08', '09:48:33', '09:21:55', '08:59:20', '08:34:01'][Math.floor(Math.random() * 12)] || '08:00:00',
    amount: q.amount,
    score: q.stage === 'PRE_RULE' ? null : q.championScore,
    decision: 'DECLINE',
    reasons: q.reasonCodes,
    overridden: false,
  }));
  const extras = [
    { id: '9f0a3e52-1c6b-77ed-9b3c-2a4f8e0c5e91', auditId: 'aud_90178', time: '13:31:19', amount: 450000, score: 0.48, decision: 'REVIEW', reasons: ['RULE', 'borderline'], overridden: true },
    { id: '7c4a82b1-d3f0-4c91-aa15-c8f1e0a44b91', auditId: 'aud_90177', time: '12:47:55', amount: 670000, score: 0.78, decision: 'ACCEPT', reasons: ['AMT_HIGH', 'PAGERANK'], overridden: true },
    { id: '2c87f30b-91d4-49a3-8e02-44ff9180c001', auditId: 'aud_90176', time: '11:19:47', amount: 38200, score: 0.71, decision: 'DECLINE', reasons: ['CLUSTER', 'HOUR'], overridden: false },
  ];
  return [...base, ...extras].sort((a, b) => (a.time < b.time ? 1 : -1));
}

export default AuditLog;
