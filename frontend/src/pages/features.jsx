// Page — Feature Catalogue (read-only).
//
// Renders the running RDA feature catalogue, fetched from
// `GET /v1/admin/features/catalog`. The catalogue is the single source
// of truth for the ONNX input contract — operators come here to confirm
// schema version, see which features are sourced from PAA's Redis hash
// vs the request body, and inspect adopter-overlay compute ops.
//
// Editing is intentionally out of scope: changes are made on disk to
// `models/feature-catalog.adopter.json` and picked up at the next RDA
// restart. The catalogue itself is loud about validation at boot — a
// malformed overlay refuses to start the server, so the UI never sees
// an inconsistent state.

import { useEffect, useMemo, useState } from 'react';
import { PageHead } from '../components/shell.jsx';
import { getFeatureCatalog } from '../api/client.js';

const SOURCE_LABEL = {
  'rda:request': 'Request',
  'rda:derived': 'Derived',
  'paa:redis': 'PAA / Redis',
  'config:lookup': 'Lookup table',
};

// Source dot colours — drawn from the Stone scale + the dashboard chart
// palette. The Ojuri brand reserves saturated accents for chart data;
// these single-pixel dots in the catalogue table count as data viz, not
// brand surface.
const SOURCE_COLOR = {
  'rda:request': 'var(--ink)',
  'rda:derived': 'var(--ink-secondary)',
  'paa:redis': 'var(--chart-allow)',
  'config:lookup': 'var(--chart-review)',
};

function Pill({ tone = 'neutral', children, title }) {
  const tones = {
    neutral: { bg: 'var(--color-background-tertiary)', fg: 'var(--color-text-secondary)' },
    info: { bg: 'var(--color-background-info)', fg: 'var(--color-text-info)' },
    success: { bg: 'var(--color-background-success)', fg: 'var(--color-text-success)' },
    warning: { bg: 'var(--color-background-warning)', fg: 'var(--color-text-warning)' },
  };
  const c = tones[tone] || tones.neutral;
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 500,
        background: c.bg,
        color: c.fg,
      }}
    >
      {children}
    </span>
  );
}

function SourceTag({ source }) {
  const label = SOURCE_LABEL[source] || source;
  const color = SOURCE_COLOR[source] || 'var(--color-text-secondary)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--color-text-secondary)',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}

export default function Features({ toast }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFeatureCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        toast && toast('Feature catalogue unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const categories = useMemo(() => {
    if (!catalog?.features) return [];
    return Array.from(new Set(catalog.features.map((f) => f.category))).sort();
  }, [catalog]);

  const sources = useMemo(() => {
    if (!catalog?.features) return [];
    return Array.from(new Set(catalog.features.map((f) => f.source))).sort();
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog?.features) return [];
    const q = query.trim().toLowerCase();
    return catalog.features.filter((f) => {
      if (categoryFilter !== 'all' && f.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && f.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        (f.description || '').toLowerCase().includes(q) ||
        String(f.index).includes(q)
      );
    });
  }, [catalog, query, categoryFilter, sourceFilter]);

  const overlayCount = useMemo(() => {
    if (!catalog?.features) return 0;
    return catalog.features.filter((f) => f.compute).length;
  }, [catalog]);

  return (
    <>
      <PageHead
        crumbs={['Sentinel', 'Configuration']}
        title="Feature catalogue"
        sub="The ONNX input contract: 64 base features plus any adopter-overlay extensions. Edited on disk; restart RDA to pick up changes."
      />

      {loading && (
        <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 12 }}>
          Loading…
        </div>
      )}

      {!loading && !catalog && (
        <div style={{ padding: 16 }}>
          <Pill tone="warning">RDA unreachable</Pill>
          <p style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            The catalogue endpoint did not respond. Confirm RDA is running and the JWT in
            <code> localStorage.sentinel.jwt </code> has the <code>models:read</code> permission.
          </p>
        </div>
      )}

      {catalog && (
        <>
          <section className="card" style={{ marginBottom: 16, padding: 16 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Schema version" value={catalog.schemaVersion} mono />
              <Stat label="Base version" value={catalog.baseVersion} />
              <Stat label="Input dimension" value={catalog.inputDimension} />
              <Stat label="Adopter overlay" value={overlayCount > 0 ? `${overlayCount} feature${overlayCount > 1 ? 's' : ''}` : 'none'} />
              {catalog.adopterSha256 && (
                <Stat label="Overlay SHA-256" value={catalog.adopterSha256.slice(0, 12) + '…'} mono title={catalog.adopterSha256} />
              )}
            </div>
            <p
              style={{
                marginTop: 12,
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                lineHeight: 1.5,
              }}
            >
              Every deployed model embeds its <code>feature_schema_version</code> in
              <code> meta.json</code>. RDA refuses to load a model whose embedded version
              doesn't match this string — that's what prevents train/serve skew when the
              overlay changes without a retrain.
            </p>
          </section>

          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <input
              type="search"
              placeholder="Search by name, description, or index…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                padding: '6px 10px',
                fontSize: 13,
                border: '1px solid var(--color-border-default)',
                borderRadius: 6,
                background: 'var(--color-background-primary)',
                color: 'var(--color-text-primary)',
                minWidth: 280,
              }}
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{
                padding: '6px 8px',
                fontSize: 13,
                border: '1px solid var(--color-border-default)',
                borderRadius: 6,
                background: 'var(--color-background-primary)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              style={{
                padding: '6px 8px',
                fontSize: 13,
                border: '1px solid var(--color-border-default)',
                borderRadius: 6,
                background: 'var(--color-background-primary)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="all">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s] || s}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
              {filtered.length} / {catalog.features.length} shown
            </span>
          </div>

          <div className="card" style={{ overflow: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border-default)' }}>
                  <Th>#</Th>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Source</Th>
                  <Th>Type</Th>
                  <Th>Default</Th>
                  <Th>Description</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr
                    key={f.index}
                    style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
                    title={f.compute ? `Compute op: ${f.compute.type}` : undefined}
                  >
                    <Td mono align="right">{f.index}</Td>
                    <Td mono>
                      {f.name}
                      {f.compute && (
                        <Pill tone="info" title={`Adopter overlay (${f.compute.type})`}>
                          overlay
                        </Pill>
                      )}
                    </Td>
                    <Td>{f.category}</Td>
                    <Td><SourceTag source={f.source} /></Td>
                    <Td mono>{f.dtype}</Td>
                    <Td mono>{String(f.default)}</Td>
                    <Td style={{ color: 'var(--color-text-secondary)' }}>
                      {f.description || '—'}
                    </Td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <Td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', padding: 20 }}>
                      No features match the current filters.
                    </Td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, mono, title }) {
  return (
    <div title={title}>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: 'var(--color-text-primary)',
          fontFamily: mono ? 'var(--font-mono, monospace)' : undefined,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children, align }) {
  return (
    <th
      style={{
        textAlign: align || 'left',
        padding: '8px 10px',
        fontWeight: 500,
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, mono, align, colSpan, style }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: '8px 10px',
        textAlign: align || 'left',
        fontFamily: mono ? 'var(--font-mono, monospace)' : undefined,
        verticalAlign: 'top',
        ...style,
      }}
    >
      {children}
    </td>
  );
}
