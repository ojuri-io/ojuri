// Page 2 — Transactions list
//
// Wired to `GET /v1/transactions` with the shared audit-style filters
// (`from`, `to`, `decision=A,B`, `search`, `overridden`, `limit`, `offset`).
// Filter chips and date-range commit only when the user explicitly acts —
// chip click for decision, Enter / blur for search, "Apply" button for
// the date range. The synthetic in-memory pool is kept as a fallback when
// the backend is unreachable.

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead, fmtNaira, fmtAge, truncId } from '../components/shell.jsx';
import { SearchInput, DateRangeFilter } from '../components/search-input.jsx';
import { Pagination } from '../components/pagination.jsx';
import { listTransactions, exportTransactions } from '../api/client.js';

const PER_PAGE = 10;

// Synthesise a small accept-list to pad the mock fallback so the UI still
// looks alive when the backend is down. Kept identical to the previous
// hardcoded set so screenshots stay reproducible.
const SYNTHETIC_ACCEPTS = [
  { id: 'c8d2a91b-67ff-4d92-a4e1-7e3f9c0c1a4b', sender: 'chidi_ng', receiver: 'adaeze_eb', amount: 12300, txnType: 'PAYMENT', score: 0.21, decision: 'ACCEPT', ageLabel: '53m', auditId: 'aud_90188' },
  { id: 'b6e1d840-3aa2-4c0e-9d8f-2510c8f1e0a4', sender: 'ola_ib', receiver: 'chiamaka_an', amount: 8750, txnType: 'CASH_OUT', score: 0.15, decision: 'ACCEPT', ageLabel: '1h', auditId: 'aud_90187' },
  { id: '4a7c5e23-9b81-48fa-bc56-1d20a8b09711', sender: 'funmi_la', receiver: 'tunde_la', amount: 95000, txnType: 'PAYMENT', score: 0.34, decision: 'ACCEPT', ageLabel: '2h', auditId: 'aud_90186' },
  { id: '7d12e9af-50bc-431f-91ce-c01a3f7b1208', sender: 'kemi_ab', receiver: 'biola_pt', amount: 24400, txnType: 'TRANSFER', score: 0.08, decision: 'ACCEPT', ageLabel: '2h 14m', auditId: 'aud_90185' },
  { id: '2af5c014-712d-4b89-86b1-44d70f1f9c00', sender: 'ifeoma_en', receiver: 'mtn_topup', amount: 5000, txnType: 'PAYMENT', score: 0.03, decision: 'ACCEPT', ageLabel: '3h', auditId: 'aud_90184' },
  { id: '9e3b81fa-65cb-4f30-ad27-08c4b3e09f55', sender: 'tobi_lag_88', receiver: 'jumia_pay', amount: 18500, txnType: 'PAYMENT', score: 0.18, decision: 'ACCEPT', ageLabel: '3h 22m', auditId: 'aud_90183' },
  { id: '5fb201ec-9c43-4d18-87a6-31de2f80b912', sender: 'seun_ib_14', receiver: 'helios_food', amount: 32000, txnType: 'PAYMENT', score: 0.27, decision: 'ACCEPT', ageLabel: '4h', auditId: 'aud_90182' },
  { id: '1c45dfae-08e7-43d2-91b2-f6e0a14d2055', sender: 'rashid_kn', receiver: 'palmpay_x', amount: 7800, txnType: 'TRANSFER', score: 0.11, decision: 'ACCEPT', ageLabel: '5h', auditId: 'aud_90181' },
];

// Normalise a row from the API (DecisionAudit shape) into the table view
// model. Kept tolerant — the API may return slightly different field names
// while still being wire-compatible.
//
// `amount` arrives as a string-numeric from pg numeric columns; coerce it so
// `Math.round` / `>` comparisons behave. `reasonCodes` is an array of
// objects (`{ code, ... }`) on the live wire — flatten the rule-stage check
// onto `decisionSource` / `ruleStage` so it doesn't `.includes` an object.
function normaliseRow(r) {
  const score =
    r.championScore ?? r.score ?? (typeof r.shadowScore === 'number' ? r.shadowScore : 0);
  const decision = r.overrideDecision || r.finalDecision || r.decision || 'ACCEPT';
  const overridden = !!r.overrideDecision || !!r.overridden;
  return {
    id: r.transactionId || r.id || '',
    auditId: r.auditId || r.id || '',
    sender: r.senderId || r.sender || '—',
    receiver: r.receiverId || r.receiver || '—',
    amount: Number(r.amount ?? 0),
    txnType: r.txnType || r.transactionType || '—',
    score: typeof score === 'number' ? score : Number(score) || 0,
    decision,
    overridden,
    ageLabel: r.ageLabel || (r.createdAt ? new Date(r.createdAt).toLocaleString() : ''),
    isRule: r.stage === 'PRE_RULE' || r.decisionSource === 'PRE_RULE' || r.ruleStage === 'PRE',
  };
}

// RFC 4180-ish escape. We don't try to support every Excel quirk —
// just enough that quotes, commas, and newlines round-trip cleanly.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  const headers = [
    'createdAt', 'transactionId', 'auditId', 'senderId', 'receiverId',
    'amount', 'transactionType', 'segment', 'finalDecision', 'decisionSource',
    'championModelVersion', 'championScore', 'shadowScore', 'threshold',
    'ruleName', 'ruleStage', 'overrideDecision', 'reviewedBy', 'latencyMs',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvCell(r[h])).join(','));
  }
  return lines.join('\n');
}

function downloadBlob(filename, mime, body) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke async so the download finishes before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function TransactionsList({ toast, nav, queue }) {
  const [decision, setDecision] = useState('ALL');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [page, setPage] = useState(1);
  const [openMenu, setOpenMenu] = useState(null);
  const [rows, setRows] = useState(null); // null = haven't tried yet
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // Mock pool (declines from `queue` + synthetic accepts) — only used when
  // the live `/v1/transactions` call falls back via `safe()`.
  const fallbackRows = useMemo(() => {
    const declined = queue.map((q) => ({
      id: q.transactionId,
      auditId: q.auditId,
      sender: q.sender,
      receiver: q.receiver,
      amount: q.amount,
      txnType: q.txnType,
      score: q.championScore || 0.77,
      decision: 'DECLINE',
      overridden: false,
      ageLabel: fmtAge(q.ageMin),
      isRule: q.stage === 'PRE_RULE',
    }));
    return [...declined, ...SYNTHETIC_ACCEPTS];
  }, [queue]);

  // Fetch whenever a *committed* filter changes. Search and date-range
  // each commit through their own helpers, so debounced typing doesn't
  // refire this effect on every keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setForbidden(false);
    const filters = {
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
      search: search || undefined,
      from: range.from || undefined,
      to: range.to || undefined,
      decision:
        decision === 'ALL'
          ? undefined
          : decision === 'OVERRIDDEN'
          ? undefined
          : [decision],
      overridden: decision === 'OVERRIDDEN' ? true : undefined,
    };
    listTransactions(filters)
      .then((res) => {
        if (cancelled) return;
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
  }, [decision, search, range.from, range.to, page]);

  // Counts shown next to each chip. When the API is healthy we don't know
  // counts for arbitrary segments without separate fetches — show the
  // total from the current response for ALL, and leave others blank until
  // the user filters.
  const counts = useMemo(() => {
    if (rows && !usedFallback) {
      return { ALL: total, ACCEPT: '·', DECLINE: '·', REVIEW: '·', OVERRIDDEN: '·' };
    }
    const r = fallbackRows;
    return {
      ALL: r.length,
      ACCEPT: r.filter((t) => t.decision === 'ACCEPT').length,
      DECLINE: r.filter((t) => t.decision === 'DECLINE').length,
      REVIEW: r.filter((t) => t.decision === 'REVIEW').length,
      OVERRIDDEN: r.filter((t) => t.overridden).length,
    };
  }, [rows, usedFallback, total, fallbackRows]);

  // Apply the same filters locally to the fallback list so the chips +
  // search still behave when running against MOCK data.
  const localFiltered = useMemo(() => {
    let list = fallbackRows;
    if (decision !== 'ALL') {
      if (decision === 'OVERRIDDEN') list = list.filter((t) => t.overridden);
      else list = list.filter((t) => t.decision === decision);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          (t.id || '').toLowerCase().includes(q) ||
          (t.sender || '').toLowerCase().includes(q) ||
          (t.receiver || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [fallbackRows, decision, search]);

  const displayRows = rows && !usedFallback ? rows : localFiltered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const displayTotal = rows && !usedFallback ? total : localFiltered.length;

  // Filters as the user sees them — used for the active-filter pill row
  // and the "Reset filters" affordance. We treat the page number as
  // navigation state, not a filter (it gets reset on commit anyway).
  const activeFilters = useMemo(() => {
    const out = [];
    if (decision !== 'ALL') out.push({ key: 'decision', label: `Decision: ${decision}`, clear: () => { setDecision('ALL'); setPage(1); } });
    if (search) out.push({ key: 'search', label: `Search: "${search}"`, clear: () => { setSearch(''); setPage(1); } });
    if (range.from || range.to) {
      const label = `Date: ${range.from || '…'} → ${range.to || 'now'}`;
      out.push({ key: 'range', label, clear: () => { setRange({ from: '', to: '' }); setPage(1); } });
    }
    return out;
  }, [decision, search, range.from, range.to]);

  const resetAll = () => {
    setDecision('ALL');
    setSearch('');
    setRange({ from: '', to: '' });
    setPage(1);
  };

  // CSV export. Pulls the same filters the table is currently showing
  // (without limit/offset so we get every match up to the cap). The
  // button shows progress while we page through, then triggers a Blob
  // download. Fallback rows are exported client-side when the API is
  // unreachable — same shape, just from the in-memory list.
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const filenameBase = `transactions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
      if (rows && !usedFallback) {
        const filters = {
          search: search || undefined,
          from: range.from || undefined,
          to: range.to || undefined,
          decision: decision === 'ALL' || decision === 'OVERRIDDEN' ? undefined : [decision],
          overridden: decision === 'OVERRIDDEN' ? true : undefined,
        };
        const { rows: all, total: matched, truncated } = await exportTransactions(filters, {
          maxRows: 5000,
          pageSize: 500,
          onProgress: (loaded) => setExportProgress(loaded),
        });
        downloadBlob(`${filenameBase}.csv`, 'text/csv;charset=utf-8', toCsv(all));
        toast(
          truncated
            ? `Exported first ${all.length.toLocaleString()} of ${matched.toLocaleString()} rows`
            : `Exported ${all.length.toLocaleString()} rows`,
          'success',
        );
      } else {
        const fallbackForExport = localFiltered.map((r) => ({
          createdAt: r.ageLabel,
          transactionId: r.id,
          auditId: r.auditId,
          senderId: r.sender,
          receiverId: r.receiver,
          amount: r.amount,
          transactionType: r.txnType,
          finalDecision: r.decision,
          championScore: r.score,
        }));
        downloadBlob(`${filenameBase}-mock.csv`, 'text/csv;charset=utf-8', toCsv(fallbackForExport));
        toast(`Exported ${fallbackForExport.length} rows (mock — API unreachable)`, 'warn');
      }
    } catch (err) {
      toast(`Export failed · ${String(err.message || err)}`, 'danger');
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  };

  if (forbidden) {
    return (
      <>
        <PageHead crumbs={['Dashboard', 'Detection']} title="Transactions" sub="Forbidden" />
        <div className="panel" style={{ padding: 36, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
          You don't have access to this view. Requires <code className="mono">audit:read</code>.
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead crumbs={['Dashboard', 'Detection']} title="Transactions" sub={`${displayTotal.toLocaleString()} decision${displayTotal === 1 ? '' : 's'} in scope`}>
        <button
          onClick={exportCsv}
          disabled={exporting || displayTotal === 0}
          title={displayTotal === 0 ? 'Nothing to export' : 'Download the filtered set as CSV (caps at 5,000 rows)'}
        >
          <Ti name={exporting ? 'loader-2' : 'download'} size={14} />
          {exporting
            ? `Exporting${exportProgress ? ` ${exportProgress.toLocaleString()}` : ''}…`
            : 'Export CSV'}
        </button>
      </PageHead>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <SearchInput
          value={search}
          onCommit={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search by transaction ID, sender, receiver… (press Enter)"
        />
      </div>

      {/* Date range filter panel — only commits on Apply or Enter */}
      <section className="panel" style={{ marginBottom: 12, padding: 12 }}>
        <DateRangeFilter
          from={range.from}
          to={range.to}
          onApply={({ from, to }) => {
            setRange({ from, to });
            setPage(1);
          }}
          onReset={() => {
            setRange({ from: '', to: '' });
            setPage(1);
          }}
        />
      </section>

      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterChip active={decision === 'ALL'} onClick={() => { setDecision('ALL'); setPage(1); }} count={counts.ALL}>All</FilterChip>
        <FilterChip active={decision === 'ACCEPT'} onClick={() => { setDecision('ACCEPT'); setPage(1); }} count={counts.ACCEPT}>Accept</FilterChip>
        <FilterChip active={decision === 'DECLINE'} onClick={() => { setDecision('DECLINE'); setPage(1); }} count={counts.DECLINE}>Decline</FilterChip>
        <FilterChip active={decision === 'REVIEW'} onClick={() => { setDecision('REVIEW'); setPage(1); }} count={counts.REVIEW}>Review</FilterChip>
        <FilterChip active={decision === 'OVERRIDDEN'} onClick={() => { setDecision('OVERRIDDEN'); setPage(1); }} count={counts.OVERRIDDEN}>Overridden</FilterChip>
        {activeFilters.length > 0 && (
          <button
            onClick={resetAll}
            title="Clear every filter"
            style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 8px' }}
          >
            <Ti name="x" size={12} />Reset filters
          </button>
        )}
      </div>

      {/* Active-filter chip strip — gives the user a one-glance summary
          of "what's scoping this list" with a × per filter. Hidden when
          nothing is filtered so the layout doesn't shift. */}
      {activeFilters.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {activeFilters.map((f) => (
            <span
              key={f.key}
              className="pill info"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 8px' }}
            >
              {f.label}
              <button
                onClick={f.clear}
                className="ghost icon-only"
                style={{ height: 16, width: 16, padding: 0 }}
                aria-label={`Clear ${f.key}`}
              >
                <Ti name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row-grid header" style={{ gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1.1fr) 56px 86px 112px 28px', padding: 'calc(var(--row-pad-y, 9px) * 0.7) 14px' }}>
          <span>TRANSACTION</span><span>AMOUNT</span><span>SCORE</span><span>DECISION</span><span>TIME</span><span></span>
        </div>
        {loading && displayRows.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
        )}
        {!loading && displayRows.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No transactions match these filters.</div>
        )}
        {displayRows.map((t, i) => (
          <div key={t.id} className="row-grid hoverable" style={{
            gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1.1fr) 56px 86px 112px 28px',
            padding: 'var(--row-pad-y, 9px) 14px',
            background: i === 0 && decision === 'ALL' && !search && !range.from && !range.to ? 'color-mix(in srgb, var(--color-background-info) 22%, transparent)' : undefined,
          }} onClick={() => nav('txn:' + t.id)}>
            <div style={{ minWidth: 0 }}>
              {/* Show the full UUID — the column has room (~570px at default
                  panel width) and `truncate` is still here as the safety
                  net if the layout ever narrows. */}
              <p className="truncate mono" style={{ margin: 0, fontSize: 11 }}>{t.id}</p>
              <p className="truncate" style={{ margin: '1px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.sender} → {t.receiver}</p>
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 12, fontWeight: 500 }}>{fmtNaira(t.amount)}</p>
              <p style={{ margin: '1px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.txnType}</p>
            </div>
            <span className={'pill round ' + scoreClass(t)} style={{ justifySelf: 'start' }}>{t.isRule ? 'rule' : t.score.toFixed(2)}</span>
            <span className={'pill ' + decisionClass(t.decision)} style={{ justifySelf: 'start', padding: '3px 8px' }}>{t.decision}</span>
            {/* `overflow: hidden` + `text-overflow: ellipsis` keeps a long
                absolute timestamp ("Wed, May 14 22:00:00") from spilling
                into the kebab-menu cell on narrow viewports. */}
            <span
              className="truncate"
              style={{
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={t.ageLabel}
            >
              {t.ageLabel}
            </span>
            <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
              <button className="ghost icon-only" onClick={() => setOpenMenu(openMenu === t.id ? null : t.id)}><Ti name="dots-vertical" size={14} /></button>
              {openMenu === t.id && (
                <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', boxShadow: 'var(--shadow-md)', minWidth: 160, padding: 4, fontSize: 12 }}>
                  <MItem icon="eye" onClick={() => { setOpenMenu(null); nav('txn:' + t.id); }}>View detail</MItem>
                  <MItem icon="shield-x" onClick={() => { setOpenMenu(null); toast(`Marked ${truncId(t.id, 10)} fraudulent`, 'danger'); }}>Mark fraudulent</MItem>
                  <MItem icon="copy" onClick={() => { setOpenMenu(null); navigator.clipboard?.writeText(t.id); toast('ID copied'); }}>Copy ID</MItem>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <Pagination
        page={page}
        pageSize={PER_PAGE}
        total={displayTotal}
        onChange={setPage}
        variant="numbered"
      />
    </>
  );
}

function FilterChip({ active, onClick, count, children }) {
  return (
    <button className={active ? 'info-bg' : ''} onClick={onClick} style={{ fontSize: 12, padding: '5px 10px' }}>
      {children}
      <span style={{ marginLeft: 6, opacity: active ? 0.7 : 1, color: active ? 'currentColor' : 'var(--color-text-tertiary)' }}>{count}</span>
    </button>
  );
}

function MItem({ icon, children, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-background-secondary)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
      <Ti name={icon} size={12} />{children}
    </div>
  );
}

function scoreClass(t) {
  if (t.isRule) return 'danger';
  if (t.score >= 0.65) return 'danger';
  if (t.score >= 0.4) return 'warn';
  return 'success';
}
function decisionClass(d) {
  if (d === 'DECLINE') return 'danger';
  if (d === 'ACCEPT') return 'success';
  if (d === 'REVIEW') return 'warn';
  return '';
}

export default TransactionsList;
