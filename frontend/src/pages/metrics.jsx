// Metrics — endpoint health (sparklines + latency + reason codes)
//
// All numbers derive from /v1/stats/window (KPIs + sparklines) and
// /v1/stats/latency (24h percentile timeseries). Top reason codes still
// reads from /v1/stats/today's `topReasonCodes` field. When the window
// is empty we render "—" instead of a stale seeded value.

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead } from '../components/shell.jsx';
import {
  getStatsToday,
  getStatsWindow,
  getLatencyTimeseries,
} from '../api/client.js';

const RANGE_SECONDS = {
  '1h': 3600,
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
};

function Metrics() {
  const [range, setRange] = useState('24h');
  const [stats, setStats] = useState(null);
  const [windowStats, setWindowStats] = useState(null);
  const [latency, setLatency] = useState(null);

  // /v1/stats/today gives us the reason-code bar chart at the bottom.
  useEffect(() => {
    let cancelled = false;
    getStatsToday()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Window + latency refetch when the user toggles the range pill.
  useEffect(() => {
    let cancelled = false;
    const seconds = RANGE_SECONDS[range] ?? 86400;
    getStatsWindow({ seconds, sparklineBuckets: 11 })
      .then((s) => {
        if (!cancelled) setWindowStats(s);
      })
      .catch(() => {
        if (!cancelled) setWindowStats(null);
      });
    const to = new Date();
    const from = new Date(to.getTime() - seconds * 1000);
    // Choose a bucket size that gives ~24 points regardless of range —
    // keeps the chart visually consistent across 1h / 24h / 7d / 30d.
    const bucketMinutes = Math.max(1, Math.round(seconds / 60 / 24));
    getLatencyTimeseries({ from: from.toISOString(), to: to.toISOString(), bucketMinutes })
      .then((r) => {
        if (!cancelled) setLatency(r);
      })
      .catch(() => {
        if (!cancelled) setLatency(null);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const fmtRate = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}` : '—';
  const fmtCount = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toString() : '—';

  const sparklineDecisions = windowStats?.sparklines?.decisions || [];
  const sparklineDeclines = windowStats?.sparklines?.declines || [];
  const sparklineOverrides = windowStats?.sparklines?.overrides || [];

  // FIA sparkline isn't returned by /v1/stats/window — there's no per-bucket
  // FIA count in the underlying table. We show the headline value but
  // collapse the sparkline to an empty line so we don't fake a series.
  const kpis = [
    {
      label: 'DECISIONS / SEC',
      value: windowStats?.decisionsPerSec != null ? windowStats.decisionsPerSec.toFixed(1) : '—',
      suffix: '',
      delta: null,
      spark: sparklineDecisions,
      color: 'info',
    },
    {
      label: 'DECLINE RATE',
      value: fmtRate(windowStats?.declineRate),
      suffix: '%',
      delta: null,
      spark: sparklineDeclines,
      color: 'danger',
    },
    {
      label: 'OVERRIDE RATE',
      value: fmtRate(windowStats?.overrideRate),
      suffix: '%',
      delta: null,
      spark: sparklineOverrides,
      color: 'warning',
    },
    {
      label: 'FIA REPORTS / HR',
      value: fmtCount(windowStats?.fiaReportsPerHour),
      suffix: '',
      delta: null,
      // No per-bucket FIA series available — keep the sparkline empty
      // rather than rendering a fake one.
      spark: [],
      color: 'info',
    },
  ];

  // Derive percentage + tone bands from the live `topReasonCodes` array.
  const reasonRows = useMemo(() => {
    const codes = stats?.topReasonCodes || [];
    if (codes.length === 0) return [];
    const top = Math.max(...codes.map((c) => c.count), 1);
    return codes.map((c) => {
      const pct = Math.round((c.count / top) * 100);
      const tone = pct >= 60 ? 'danger' : pct >= 30 ? 'warning' : 'info';
      return { code: c.code, count: c.count, pct, tone };
    });
  }, [stats]);

  return (
    <>
      <PageHead crumbs={['Dashboard', 'Insights']} title="Metrics" sub="Predict endpoint health · derived from decisionAuditLog">
        <div style={{ display: 'flex', gap: 0, border: '0.5px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden' }}>
          {Object.keys(RANGE_SECONDS).map((r) => (
            <button
              key={r}
              className={range === r ? 'info-bg' : ''}
              onClick={() => setRange(r)}
              style={{
                padding: '5px 10px',
                fontSize: 11,
                border: 'none',
                borderRadius: 0,
                background: range === r ? 'var(--color-background-info)' : 'transparent',
                color: range === r ? 'var(--color-text-info)' : 'var(--color-text-secondary)',
                fontWeight: range === r ? 500 : 400,
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </PageHead>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
        {kpis.map((k) => (
          <KpiTile key={k.label} {...k} />
        ))}
      </div>

      {/* Latency chart */}
      <section className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-head">
          <div>
            <h2>/v1/predict latency</h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>Server-side, excludes network</p>
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--color-text-secondary)' }}>
            <LegendStripe color="var(--color-text-info)" label={`p50 · ${fmtMs(windowStats?.championLatency?.p50)}`} />
            <LegendStripe color="var(--color-text-warning)" label={`p95 · ${fmtMs(windowStats?.championLatency?.p95)}`} />
            <LegendStripe color="var(--color-text-danger)" label={`p99 · ${fmtMs(windowStats?.championLatency?.p99)}`} />
          </div>
        </div>
        <LatencyChart buckets={latency?.buckets || []} />
      </section>

      {/* Top reason codes */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Top reason codes</h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>Across all DECLINE decisions, since {stats?.since ? new Date(stats.since).toLocaleString() : '—'}</p>
          </div>
        </div>
        {reasonRows.length === 0 ? (
          <p style={{ margin: 0, padding: '10px 0', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No DECLINE decisions in this window yet — codes will populate once predictions start firing.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {reasonRows.map((r) => (
              <div key={r.code} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 50px', gap: 10, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 11 }}>{r.code}</span>
                <div style={{ height: 6, background: 'var(--color-background-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${r.pct}%`, background: `var(--color-text-${r.tone})` }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 500, textAlign: 'right' }}>{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function fmtMs(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}ms` : '—';
}

function KpiTile({ label, value, suffix, delta, spark, color }) {
  const stroke = `var(--color-text-${color})`;
  const max = Math.max(...spark, 1);
  const min = Math.min(...spark, 0);
  const span = Math.max(0.0001, max - min);
  return (
    <div className="tile bordered" style={{ padding: 12 }}>
      <p className="label-up" style={{ margin: 0 }}>{label}</p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '4px 0 8px', whiteSpace: 'nowrap' }}>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>
          {value}
          {suffix && value !== '—' && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 2 }}>{suffix}</span>}
        </p>
        {delta && <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{delta}</span>}
      </div>
      {spark.length > 1 ? (
        <svg viewBox="0 0 120 28" style={{ width: '100%', height: 28 }}>
          <polyline
            fill="none"
            stroke={stroke}
            strokeWidth="1.2"
            points={spark.map((v, i) => `${i * (120 / (spark.length - 1))},${24 - ((v - min) / span) * 18}`).join(' ')}
          />
        </svg>
      ) : (
        <div style={{ height: 28 }} />
      )}
    </div>
  );
}

function LegendStripe({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      <span style={{ width: 8, height: 2, background: color }} />
      {label}
    </span>
  );
}

function LatencyChart({ buckets }) {
  const W = 720,
    H = 180,
    pad = { l: 36, r: 16, t: 16, b: 32 };
  const innerW = W - pad.l - pad.r,
    innerH = H - pad.t - pad.b;

  if (!buckets || buckets.length === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5" />
        <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5" />
        <text x={pad.l + innerW / 2} y={pad.t + innerH / 2} fontSize="11" fill="var(--color-text-tertiary)" textAnchor="middle">
          No latency data yet — make some predictions to populate this chart.
        </text>
      </svg>
    );
  }

  const maxV = Math.max(10, ...buckets.flatMap((b) => [b.p50 || 0, b.p95 || 0, b.p99 || 0]));
  const yScale = (v) => pad.t + innerH - (v / maxV) * innerH;
  const xScale = (i) => pad.l + (i / Math.max(1, buckets.length - 1)) * innerW;
  const line = (key) => buckets.map((b, i) => `${xScale(i)},${yScale(b[key] || 0)}`).join(' ');

  const ticks = [Math.round(maxV * 0.25), Math.round(maxV * 0.5), Math.round(maxV)];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5" />
      <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="var(--color-border-secondary)" strokeWidth="0.5" />
      {ticks.map((g) => (
        <g key={g}>
          <line x1={pad.l} y1={yScale(g)} x2={pad.l + innerW} y2={yScale(g)} stroke="var(--color-border-tertiary)" strokeWidth="0.5" strokeDasharray="2,3" />
          <text x={pad.l - 4} y={yScale(g) + 3} fontSize="9" fill="var(--color-text-tertiary)" textAnchor="end" fontFamily="var(--font-mono)">{g}</text>
        </g>
      ))}
      <polyline fill="none" stroke="var(--color-text-danger)" strokeWidth="1.4" points={line('p99')} />
      <polyline fill="none" stroke="var(--color-text-warning)" strokeWidth="1.4" points={line('p95')} />
      <polyline fill="none" stroke="var(--color-text-info)" strokeWidth="1.4" points={line('p50')} />
      <text x={pad.l} y={H - 8} fontSize="9" fill="var(--color-text-tertiary)" fontFamily="var(--font-mono)">
        {buckets[0]?.ts ? new Date(buckets[0].ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}
      </text>
      <text x={pad.l + innerW} y={H - 8} fontSize="9" fill="var(--color-text-tertiary)" fontFamily="var(--font-mono)" textAnchor="end">now</text>
    </svg>
  );
}

export default Metrics;
