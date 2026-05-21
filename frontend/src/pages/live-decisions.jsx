// Live decisions — polling feed
//
// Polls `GET /v1/decisions/recent?since=<last seen createdAt>` every 1s
// while not paused, prepending newer audit rows. RPS / accept-rate /
// p95 / total-since-start are all derived from the rolling window. The
// previous client-side simulator has been retired.

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Ti, PageHead, fmtNaira } from '../components/shell.jsx';
import { listRecentDecisions } from '../api/client.js';

const POLL_INTERVAL_MS = 1000;
const WINDOW_SECONDS = 60;
const MAX_ROWS = 60;
const SPARK_BUCKETS = 31;

function LiveDecisions({ nav }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('ALL');
  // Rows accumulated this session, newest-first. Polling appends new rows
  // whose `createdAt` is strictly newer than the last we've seen.
  const [rows, setRows] = useState([]);
  const [totalSinceStart, setTotalSinceStart] = useState(0);
  const [sparkBuckets, setSparkBuckets] = useState(() => new Array(SPARK_BUCKETS).fill(0));
  const lastSeenRef = useRef(null);
  const startedAtRef = useRef(Date.now());
  const sessionStartRef = useRef(Date.now());

  // Set of audit-row ids already merged into `rows`. Defends against
  // server-side cursor precision quirks — even if the same `createdAt`
  // value comes back twice, we'll only count and render the row once.
  const seenIdsRef = useRef(new Set());

  useEffect(() => {
    if (paused) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const data = await listRecentDecisions({ since: lastSeenRef.current, limit: 50 });
        if (cancelled) return;
        if (!Array.isArray(data) || data.length === 0) return;
        const seen = seenIdsRef.current;
        // Filter the incoming page to only rows we haven't already
        // counted/rendered. The first poll on mount has an empty `seen`
        // set so the initial batch all flows through.
        const fresh = [];
        for (const row of data) {
          const key = row.id || row.auditId || row.transactionId;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          fresh.push(row);
        }
        // Advance the cursor to the newest seen createdAt regardless of
        // whether the rows were duplicates — that's how we converge.
        const newest = data[0]?.createdAt;
        if (newest) lastSeenRef.current = newest;
        if (fresh.length === 0) return;
        setRows((prev) => [...fresh.map(normaliseRow), ...prev].slice(0, MAX_ROWS));
        setTotalSinceStart((n) => n + fresh.length);
      } catch {
        /* polling soldiers on through transient errors */
      }
    };
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paused]);

  // Maintain a rolling-second sparkline. Each second we bucket the count
  // of rows whose createdAt fell inside that second.
  useEffect(() => {
    const id = setInterval(() => {
      setSparkBuckets((prev) => {
        const next = prev.slice(1);
        const now = Date.now();
        const oneAgo = now - 1000;
        // Look at rows ingested in the last second.
        const recent = rows.filter((r) => {
          const t = r._ts;
          return t >= oneAgo && t < now;
        }).length;
        next.push(recent);
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [rows]);

  const sessionDurationSec = useMemo(() => Math.max(1, (Date.now() - sessionStartRef.current) / 1000), [totalSinceStart]);

  const windowRows = useMemo(() => {
    const cutoff = Date.now() - WINDOW_SECONDS * 1000;
    return rows.filter((r) => r._ts >= cutoff);
  }, [rows]);

  const rps = windowRows.length / WINDOW_SECONDS;
  const accepts = windowRows.filter((r) => r.decision === 'ACCEPT').length;
  const acceptRate = windowRows.length ? (accepts / windowRows.length) * 100 : null;
  const p95Latency = percentile(windowRows.map((r) => r.latencyMs).filter((v) => typeof v === 'number'), 0.95);

  const filtered = filter === 'ALL' ? rows : rows.filter((r) => r.decision === filter);

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Detection']}
        title="Live decisions"
        sub={`Polling /v1/decisions/recent every ${POLL_INTERVAL_MS}ms · last ${WINDOW_SECONDS}s window`}
      >
        <button className={paused ? '' : 'danger-bg'} onClick={() => setPaused((p) => !p)} style={{ fontWeight: 500 }}>
          <Ti name={paused ? 'player-play' : 'player-pause'} size={14} />
          {paused ? 'Resume stream' : 'Pause stream'}
        </button>
      </PageHead>

      {/* Live stats row */}
      <section className="panel" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, alignItems: 'flex-end' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span
                className={'live-pulse'}
                style={{ width: 7, height: 7, borderRadius: '50%', background: paused ? 'var(--color-text-tertiary)' : 'var(--color-text-success)' }}
              />
              <p className="label-up" style={{ margin: 0 }}>{paused ? 'PAUSED' : 'LIVE'}</p>
            </div>
            <p className="stat-display sm" style={{ margin: 0 }}>
              {windowRows.length ? rps.toFixed(1) : '—'}
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 400, color: 'var(--ink-muted)', marginLeft: 6 }}>decisions/sec</span>
            </p>
          </div>
          <div>
            <p className="label-up" style={{ margin: '0 0 6px' }}>Accept rate</p>
            <p className="stat-display sm" style={{ margin: 0 }}>
              {acceptRate == null ? '—' : `${acceptRate.toFixed(1)}%`}
            </p>
          </div>
          <div>
            <p className="label-up" style={{ margin: '0 0 6px' }}>p95 latency</p>
            <p className="stat-display sm" style={{ margin: 0 }}>
              {p95Latency == null ? '—' : <>{p95Latency.toFixed(1)}<span style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 400, color: 'var(--ink-muted)', marginLeft: 4 }}>ms</span></>}
            </p>
          </div>
          <div>
            <p className="label-up" style={{ margin: '0 0 6px' }}>Since start</p>
            <p className="stat-display sm" style={{ margin: 0 }}>{totalSinceStart.toLocaleString()}</p>
          </div>
        </div>

        {/* Sparkline — N seconds of per-second counts */}
        <div style={{ marginTop: 12 }}>
          <svg viewBox="0 0 620 64" style={{ width: '100%', height: 'auto' }}>
            <line x1="0" y1="48" x2="620" y2="48" stroke="var(--color-border-tertiary)" strokeWidth="0.5" />
            <polyline
              fill="none"
              stroke="var(--color-text-info)"
              strokeWidth="1.5"
              points={sparkPath(sparkBuckets)}
            />
            {sparkBuckets[sparkBuckets.length - 1] != null && (
              <circle
                cx={(sparkBuckets.length - 1) * (620 / (sparkBuckets.length - 1))}
                cy={48 - Math.min(40, sparkBuckets[sparkBuckets.length - 1] * 4)}
                r="3"
                fill="var(--color-text-info)"
              />
            )}
            <text x="0" y="60" fontSize="9" fill="var(--color-text-tertiary)" fontFamily="var(--font-mono)">{WINDOW_SECONDS}s ago</text>
            <text x="612" y="60" fontSize="9" fill="var(--color-text-tertiary)" fontFamily="var(--font-mono)" textAnchor="end">now</text>
          </svg>
        </div>
      </section>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={filter === 'ALL' ? 'info-bg' : ''} onClick={() => setFilter('ALL')} style={{ fontSize: 12, padding: '5px 10px' }}>All</button>
        <button className={filter === 'ACCEPT' ? 'info-bg' : ''} onClick={() => setFilter('ACCEPT')} style={{ fontSize: 12, padding: '5px 10px' }}>Accept</button>
        <button className={filter === 'DECLINE' ? 'info-bg' : ''} onClick={() => setFilter('DECLINE')} style={{ fontSize: 12, padding: '5px 10px' }}>Decline</button>
        <button className={filter === 'REVIEW' ? 'info-bg' : ''} onClick={() => setFilter('REVIEW')} style={{ fontSize: 12, padding: '5px 10px' }}>Review</button>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Ti name="info-circle" size={12} />Newest at top · polled every {POLL_INTERVAL_MS}ms
        </span>
      </div>

      {/* Stream */}
      <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="row-grid header"
          style={{ gridTemplateColumns: '70px 1.4fr 1fr 70px 80px 24px', padding: 'calc(var(--row-pad-y, 9px) * 0.7) 14px', background: 'var(--color-background-secondary)' }}
        >
          <span>WHEN</span><span>TRANSACTION</span><span>AMOUNT</span><span>SCORE</span><span>DECISION</span><span></span>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No decisions yet — make some predictions to populate this feed.
          </div>
        )}
        {filtered.map((r, i) => {
          const navigable = !!(nav && r.transactionId);
          const onRowClick = navigable ? () => nav('txn:' + r.transactionId) : undefined;
          return (
            <div
              key={r.id}
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
                gridTemplateColumns: '70px 1.4fr 1fr 70px 80px 24px',
                padding: 'var(--row-pad-y, 9px) 14px',
                cursor: navigable ? 'pointer' : 'default',
                background: i === 0 && !paused ? 'color-mix(in srgb, var(--color-background-info) 12%, transparent)' : 'transparent',
                animation: i === 0 ? 'fadeIn 0.25s ease-out' : 'none',
              }}
            >
              <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: i === 0 ? 'var(--color-text-info)' : 'var(--color-text-tertiary)' }}>{r.when}</span>
              <code className="mono truncate" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{r.transactionId}</code>
              <span style={{ fontSize: 12 }}>{fmtNaira(r.amount)}</span>
              <span className={'pill round ' + decisionToneClass(r.score, r.decision)} style={{ justifySelf: 'start' }}>
                {typeof r.score === 'number' ? r.score.toFixed(2) : '—'}
              </span>
              <span className={'pill ' + decisionToneClass(r.score, r.decision)} style={{ justifySelf: 'start', padding: '2px 7px' }}>{r.decision}</span>
              {navigable
                ? <Ti name="arrow-right" size={12} style={{ color: 'var(--color-text-tertiary)', justifySelf: 'end' }} />
                : <span />}
            </div>
          );
        })}
      </section>

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } } .live-pulse { animation: pulse 1.4s infinite; } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </>
  );
}

function decisionToneClass(score, d) {
  if (d === 'DECLINE') return 'danger';
  if (d === 'REVIEW') return 'warn';
  return 'success';
}

// Normalise a server audit row into the shape the feed renders. Cached
// `_ts` (epoch ms) saves repeated Date construction in hot filters.
//
// `amount` arrives as a string-numeric from pg numeric; coerce so the
// table's `fmtNaira` (which does `Math.round`) stays numeric.
function normaliseRow(r) {
  const created = r.createdAt ? new Date(r.createdAt).getTime() : Date.now();
  return {
    id: r.id || r.auditId || r.transactionId || '',
    transactionId: r.transactionId || '',
    amount: Number(r.amount ?? 0),
    score: r.championScore ?? r.shadowScore ?? null,
    decision: r.finalDecision || r.overrideDecision || r.mlDecision || 'ACCEPT',
    latencyMs: r.latencyMs ?? null,
    when: formatWhen(created),
    _ts: created,
  };
}

function formatWhen(t) {
  const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (deltaSec < 2) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return `${Math.floor(deltaSec / 3600)}h ago`;
}

function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function sparkPath(spark) {
  const max = Math.max(...spark, 1);
  const step = 620 / Math.max(1, spark.length - 1);
  return spark
    .map((v, i) => `${i * step},${48 - (v / max) * 36}`)
    .join(' ');
}

export default LiveDecisions;
