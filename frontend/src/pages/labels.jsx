// Page — Labels.
//
// Manual entry point for verified fraud outcomes when no automated
// chargeback feed exists yet. Paste transaction ids (optionally with a
// per-line verdict), pick a source, submit → POST /v1/admin/labels.
// The write path follows the app convention: try the real call, toast
// on failure, keep the form state so the operator can retry. The
// response's applied/unmatched split renders inline — unmatched ids
// usually mean PAA hasn't flushed the transaction row yet.

import React, { useMemo, useState } from 'react';
import { PageHead, hasPermission } from '../components/shell.jsx';
import { ingestLabels } from '../api/client.js';

const SOURCES = [
  { value: 'chargeback', label: 'Chargeback' },
  { value: 'dispute', label: 'Dispute' },
  { value: 'customer_report', label: 'Customer report' },
];

const MAX_BATCH = 1000;

// Accepts one entry per line: `txid` (uses the page-level verdict) or
// `txid,<verdict>` where verdict ∈ true/false/fraud/legit/1/0.
export function parseLabelLines(text, defaultIsFraud) {
  const labels = [];
  const errors = [];

  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line, i) => {
    const [rawId, rawVerdict, ...rest] = line.split(',').map((part) => part.trim());
    if (!rawId || rest.length > 0) {
      errors.push(`line ${i + 1}: expected "transaction_id" or "transaction_id,verdict"`);
      return;
    }

    let isFraud = defaultIsFraud;
    if (rawVerdict !== undefined && rawVerdict !== '') {
      const v = rawVerdict.toLowerCase();
      if (['true', 'fraud', '1', 'yes'].includes(v)) isFraud = true;
      else if (['false', 'legit', 'legitimate', '0', 'no'].includes(v)) isFraud = false;
      else {
        errors.push(`line ${i + 1}: unknown verdict "${rawVerdict}" (use fraud/legit)`);
        return;
      }
    }

    const existing = labels.findIndex((l) => l.transaction_id === rawId);
    if (existing >= 0) labels.splice(existing, 1);
    labels.push({ transaction_id: rawId, is_fraud: isFraud });
  });

  return { labels, errors };
}

export default function Labels({ toast, user }) {
  const canWrite = hasPermission(user, 'labels:write');

  const [text, setText] = useState('');
  const [source, setSource] = useState('chargeback');
  const [defaultVerdict, setDefaultVerdict] = useState('fraud');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const parsed = useMemo(
    () => parseLabelLines(text, defaultVerdict === 'fraud'),
    [text, defaultVerdict],
  );

  const canSubmit =
    canWrite &&
    !submitting &&
    parsed.labels.length > 0 &&
    parsed.labels.length <= MAX_BATCH &&
    parsed.errors.length === 0;

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const payload = parsed.labels.map((l) => ({ ...l, source }));
      const res = await ingestLabels(payload);
      setResult(res);
      setText('');
      toast && toast(`${res.applied} of ${res.received} labels applied`);
    } catch (err) {
      toast && toast(`Label ingest failed: ${String(err.message || err).slice(0, 100)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHead
        crumbs={['Sentinel', 'Configuration']}
        title="Labels"
        sub="Push verified fraud outcomes (chargebacks, disputes, customer reports) onto transactions. Labels feed the next retrain and light up the fraud-proximity graph features. For recurring feeds, integrate directly with POST /v1/admin/labels."
      />

      <section className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Default verdict</span>
            <select
              value={defaultVerdict}
              onChange={(e) => setDefaultVerdict(e.target.value)}
              style={inputStyle}
            >
              <option value="fraud">Fraud (confirmed)</option>
              <option value="legit">Legitimate (cleared)</option>
            </select>
          </label>
        </div>

        <label style={{ display: 'block', marginBottom: 8 }}>
          <span style={labelStyle}>Transaction ids — one per line, optional per-line verdict</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'tx-2026-0001\ntx-2026-0002,legit\ntx-2026-0003,fraud'}
            rows={10}
            spellCheck={false}
            style={{
              width: '100%',
              marginTop: 4,
              padding: 8,
              fontSize: 13,
              fontFamily: 'var(--font-mono, monospace)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 4,
              background: 'var(--color-background-primary)',
              color: 'var(--color-text-primary)',
              resize: 'vertical',
            }}
          />
        </label>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn-primary"
            disabled={!canSubmit}
            onClick={submit}
            title={!canWrite ? 'Requires labels:write permission' : ''}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              borderRadius: 4,
              border: '1px solid var(--color-border-info)',
              background: canSubmit ? 'var(--color-text-info)' : 'var(--color-background-tertiary)',
              color: canSubmit ? 'white' : 'var(--color-text-tertiary)',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'Submitting…' : `Apply ${parsed.labels.length || ''} label${parsed.labels.length === 1 ? '' : 's'}`}
          </button>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            {parsed.labels.length} parsed · max {MAX_BATCH} per batch
          </span>
        </div>

        {parsed.errors.length > 0 && (
          <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 12, color: 'var(--color-text-warning)' }}>
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={e}>{e}</li>
            ))}
            {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}
          </ul>
        )}
      </section>

      {result && (
        <section className="card" style={{ padding: 16 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Last submission</h2>
          <p style={{ margin: '6px 0', fontSize: 13 }}>
            {result.applied} of {result.received} applied
            {result.unmatched?.length > 0 ? ` — ${result.unmatched.length} unmatched` : ''}
          </p>
          {result.unmatched?.length > 0 && (
            <>
              <p style={{ margin: '4px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                Unmatched ids have no transactions row yet (PAA batches writes every ~10s) — retry them in a minute:
              </p>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  fontSize: 12,
                  background: 'var(--color-background-tertiary)',
                  borderRadius: 4,
                  maxHeight: 160,
                  overflow: 'auto',
                }}
              >
                {result.unmatched.join('\n')}
              </pre>
            </>
          )}
        </section>
      )}
    </>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 };
const labelStyle = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const inputStyle = {
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid var(--color-border-default)',
  borderRadius: 4,
  background: 'var(--color-background-primary)',
  color: 'var(--color-text-primary)',
};
