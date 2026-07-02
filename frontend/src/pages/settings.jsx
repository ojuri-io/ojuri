// Page — Settings.
//
// Three operator-facing config cards, all backed by live admin endpoints.
// No mocks: if the API is unreachable, the cards show their unreachable
// states rather than fake values that the user can't actually save.
//
//   1. Fraud threshold — RDA  /v1/admin/settings/runtime
//   2. Drift detection — MLA  /mla/v1/admin/drift-config
//   3. Manual retrain  — MLA  /mla/v1/admin/retrain + retrain-runs
//
// Validation is mirrored: the UI clamps inputs and disables submit on
// out-of-range values, but the server enforces the same bounds and is
// the source of truth (a curl bypass gets the same 422 message).

import React, { useEffect, useState, useCallback } from 'react';
import { PageHead, Ti } from '../components/shell.jsx';
import {
  listRuntimeSettings,
  updateRuntimeSetting,
  getDriftConfig,
  updateDriftConfig,
  triggerManualRetrain,
  listRetrainRuns,
} from '../api/client.js';

// Server-side clamps, mirrored client-side. Server still enforces.
const BOUNDS = {
  fraud_threshold:    { min: 0.01, max: 0.99,    step: 0.01,  label: 'Fraud threshold' },
  review_margin:      { min: 0,    max: 0.5,     step: 0.01,  label: 'Review margin' },
  driftF1Threshold:   { min: 0.5,  max: 0.99,    step: 0.01,  label: 'F1 threshold' },
  driftPsiThreshold:  { min: 0.05, max: 0.5,     step: 0.01,  label: 'PSI threshold' },
  driftWindowSize:    { min: 100,  max: 100_000, step: 100,   label: 'Window size' },
  continuedTreesPerRound: { min: 10, max: 500, step: 10, label: 'Trees per CONTINUED round' },
};

const TRAINING_MODES = ['FRESH', 'CONTINUED'];

export default function Settings({ toast, user }) {
  const canWriteSettings = hasPerm(user, 'settings:write');
  const canConfigureMla = hasPerm(user, 'mla:configure');

  return (
    <>
      <PageHead
        crumbs={['Sentinel', 'Configuration']}
        title="Settings"
        sub="Operator-controlled runtime knobs. Each change takes effect within seconds; the server enforces the documented bounds regardless of client validation."
      />
      <FraudThresholdCard toast={toast} canWrite={canWriteSettings} />
      <ReviewBandCard toast={toast} canWrite={canWriteSettings} />
      <DriftCard toast={toast} canWrite={canConfigureMla} />
      <RetrainCard toast={toast} canTrigger={canConfigureMla} />
    </>
  );
}

function hasPerm(user, code) {
  if (!user) return false;
  const perms = user.permissions || [];
  return perms.includes('*') || perms.includes(code);
}

// ──────── Card 1: Fraud threshold ────────────────────────────

function FraudThresholdCard({ toast, canWrite }) {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);     // the runtimeSettings row
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const rows = await listRuntimeSettings();
    const ft = Array.isArray(rows) ? rows.find((r) => r.key === 'fraud_threshold') : null;
    setRow(ft || null);
    setDraft(ft ? String(ft.value) : '');
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const n = Number(draft);
  const draftValid = Number.isFinite(n) && n >= BOUNDS.fraud_threshold.min && n <= BOUNDS.fraud_threshold.max;
  const dirty = row && draft !== String(row.value);

  const save = async () => {
    if (!draftValid || !dirty) return;
    setSaving(true);
    try {
      await updateRuntimeSetting('fraud_threshold', n);
      toast && toast(`Fraud threshold → ${n}`);
      await refresh();
    } catch (err) {
      toast && toast(`Save failed: ${err.message.slice(0, 80)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Fraud threshold" subtitle="Probability ≥ this value → DECLINE. Used as the fallback when no per-segment or per-model threshold is set.">
      <Help>
        <p><b>Resolution order</b> (highest wins): per-segment threshold &rarr; active model's defaultThreshold &rarr; <i>this value</i> &rarr; env <code>FRAUD_THRESHOLD</code>.</p>
        <p style={{ marginTop: 6 }}><b>Higher</b> = fewer false declines, more fraud accepted. <b>Lower</b> = more declines, more false positives. Reasonable production range: <code>0.55 – 0.80</code>.</p>
      </Help>

      {/* Show placeholder only when we have nothing to render —
          otherwise keep the existing row visible across refetches. */}
      {loading && !row && <Muted>Loading…</Muted>}

      {!loading && !row && <Muted>RDA admin unreachable.</Muted>}

      {row && (
        <Row>
          <Field
            label={`Threshold (${BOUNDS.fraud_threshold.min}–${BOUNDS.fraud_threshold.max})`}
            value={draft}
            onChange={setDraft}
            step={BOUNDS.fraud_threshold.step}
            bounds={BOUNDS.fraud_threshold}
            disabled={!canWrite || saving}
          />
          <Stat label="Current" value={row.value} />
          <Stat label="Last updated by" value={row.updatedBy || '— never —'} />
          <button
            className="btn-primary"
            disabled={!canWrite || !draftValid || !dirty || saving}
            onClick={save}
            style={btnStyle(canWrite && draftValid && dirty && !saving)}
            title={!canWrite ? 'Requires settings:write permission' : ''}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </Row>
      )}
    </Card>
  );
}

// ──────── Card 1b: Review band ───────────────────────────────

function ReviewBandCard({ toast, canWrite }) {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const rows = await listRuntimeSettings();
    const rm = Array.isArray(rows) ? rows.find((r) => r.key === 'review_margin') : null;
    setRow(rm || null);
    setDraft(rm ? String(rm.value) : '');
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const n = Number(draft);
  const draftValid = Number.isFinite(n) && n >= BOUNDS.review_margin.min && n <= BOUNDS.review_margin.max;
  const dirty = row && draft !== String(row.value);

  const save = async () => {
    if (!draftValid || !dirty) return;
    setSaving(true);
    try {
      await updateRuntimeSetting('review_margin', n);
      toast && toast(n > 0 ? `Review band → ${n}` : 'Review band disabled');
      await refresh();
    } catch (err) {
      toast && toast(`Save failed: ${err.message.slice(0, 80)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Review band" subtitle="Scores within this margin below the decline threshold return REVIEW and enter the analyst queue instead of a silent ACCEPT. 0 disables the band.">
      <Help>
        <p>The band turns the model's uncertainty into labels: borderline transactions get a human verdict, and every verdict feeds the next retrain. With threshold <code>0.70</code> and margin <code>0.15</code>, scores in <code>[0.55, 0.70)</code> go to REVIEW.</p>
        <p style={{ marginTop: 6 }}>Size it to your analyst capacity — every point of margin adds queue volume. Start small (<code>0.05</code>) and widen if the queue stays manageable.</p>
      </Help>

      {loading && !row && <Muted>Loading…</Muted>}
      {!loading && !row && <Muted>RDA admin unreachable, or the review_margin migration hasn't run.</Muted>}

      {row && (
        <Row>
          <Field
            label={`Margin (${BOUNDS.review_margin.min}–${BOUNDS.review_margin.max})`}
            value={draft}
            onChange={setDraft}
            step={BOUNDS.review_margin.step}
            bounds={BOUNDS.review_margin}
            disabled={!canWrite || saving}
          />
          <Stat label="Current" value={row.value} />
          <Stat label="Band" value={Number(row.value) > 0 ? 'ACTIVE' : 'OFF'} />
          <button
            className="btn-primary"
            disabled={!canWrite || !draftValid || !dirty || saving}
            onClick={save}
            style={btnStyle(canWrite && draftValid && dirty && !saving)}
            title={!canWrite ? 'Requires settings:write permission' : ''}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </Row>
      )}
    </Card>
  );
}

// ──────── Card 2: Drift detection ────────────────────────────

function DriftCard({ toast, canWrite }) {
  const [loading, setLoading] = useState(true);
  const [server, setServer] = useState(null);  // GET response
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await getDriftConfig();
    if (data) {
      setServer(data);
      setDraft({
        driftF1Threshold: data.driftF1Threshold,
        driftPsiThreshold: data.driftPsiThreshold,
        driftWindowSize: data.driftWindowSize,
        autoRetrainEnabled: data.autoRetrainEnabled,
        trainingMode: data.trainingMode ?? 'FRESH',
        continuedTreesPerRound: data.continuedTreesPerRound ?? 50,
      });
    } else {
      setServer(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const draftValid =
    server &&
    Number(draft.driftF1Threshold) >= BOUNDS.driftF1Threshold.min &&
    Number(draft.driftF1Threshold) <= BOUNDS.driftF1Threshold.max &&
    Number(draft.driftPsiThreshold) >= BOUNDS.driftPsiThreshold.min &&
    Number(draft.driftPsiThreshold) <= BOUNDS.driftPsiThreshold.max &&
    Number(draft.driftWindowSize) >= BOUNDS.driftWindowSize.min &&
    Number(draft.driftWindowSize) <= BOUNDS.driftWindowSize.max &&
    TRAINING_MODES.includes(draft.trainingMode) &&
    Number(draft.continuedTreesPerRound) >= BOUNDS.continuedTreesPerRound.min &&
    Number(draft.continuedTreesPerRound) <= BOUNDS.continuedTreesPerRound.max;
  const dirty =
    server &&
    (Number(draft.driftF1Threshold) !== server.driftF1Threshold ||
      Number(draft.driftPsiThreshold) !== server.driftPsiThreshold ||
      Number(draft.driftWindowSize) !== server.driftWindowSize ||
      !!draft.autoRetrainEnabled !== !!server.autoRetrainEnabled ||
      draft.trainingMode !== (server.trainingMode ?? 'FRESH') ||
      Number(draft.continuedTreesPerRound) !== (server.continuedTreesPerRound ?? 50));

  const save = async () => {
    if (!draftValid || !dirty) return;
    setSaving(true);
    try {
      await updateDriftConfig({
        driftF1Threshold: Number(draft.driftF1Threshold),
        driftPsiThreshold: Number(draft.driftPsiThreshold),
        driftWindowSize: Number(draft.driftWindowSize),
        autoRetrainEnabled: !!draft.autoRetrainEnabled,
        trainingMode: draft.trainingMode,
        continuedTreesPerRound: Number(draft.continuedTreesPerRound),
      });
      toast && toast('Drift config updated');
      await refresh();
    } catch (err) {
      toast && toast(`Save failed: ${err.message.slice(0, 80)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Drift detection" subtitle="Either signal alone (poor F1 OR feature distribution shift) triggers an automatic retrain. Window is the rolling sample count both signals are computed over.">
      <Help>
        <p>
          <b>F1 threshold</b> — retrain fires when the rolling F1-score on labelled samples drops below this value. <i>Higher</i> = retrain sooner, more thrash; <i>lower</i> = save compute, risk drift. Typical: <code>0.85 – 0.95</code>.
        </p>
        <p style={{ marginTop: 6 }}>
          <b>PSI threshold</b> — retrain fires when any tracked feature's distribution shifts past this value. Industry scale: <code>&lt; 0.10</code> stable · <code>0.10–0.25</code> moderate shift · <code>&gt; 0.25</code> significant. Default <code>0.25</code> fires on the third band.
        </p>
        <p style={{ marginTop: 6 }}>
          <b>Window size</b> — rolling sample count for both F1 and PSI. <i>Smaller</i> = react faster, more noise; <i>larger</i> = smoother, slower. Below <code>100</code> the detector won't fire at all (min-sample guard).
        </p>
        <p style={{ marginTop: 6 }}>
          <b>Auto-retrain</b> — when off, drift detection still runs and logs reasons but doesn't kick off training. Use this for a maintenance window where you don't want a model swap mid-incident.
        </p>
        <p style={{ marginTop: 6 }}>
          <b>Training mode</b> — <code>FRESH</code> retrains from scratch every time (current behaviour, expensive but unbiased). <code>CONTINUED</code> seeds the new XGBoost run from the current production model and adds <i>Trees/round</i> more trees on top — cheaper and incremental, but risks compounding bias if the new data is skewed. The A/B gate still rejects models that don't beat production.
        </p>
      </Help>

      {loading && !server && <Muted>Loading…</Muted>}

      {!loading && !server && <Muted>MLA admin unreachable.</Muted>}

      {server && (
        <>
          <Row>
            <Field
              label="F1 threshold (0.5–0.99)"
              value={draft.driftF1Threshold}
              onChange={(v) => setDraft({ ...draft, driftF1Threshold: v })}
              step={BOUNDS.driftF1Threshold.step}
              bounds={BOUNDS.driftF1Threshold}
              disabled={!canWrite || saving}
            />
            <Field
              label="PSI threshold (0.05–0.5)"
              value={draft.driftPsiThreshold}
              onChange={(v) => setDraft({ ...draft, driftPsiThreshold: v })}
              step={BOUNDS.driftPsiThreshold.step}
              bounds={BOUNDS.driftPsiThreshold}
              disabled={!canWrite || saving}
            />
            <Field
              label="Window size (100–100k)"
              value={draft.driftWindowSize}
              onChange={(v) => setDraft({ ...draft, driftWindowSize: v })}
              step={BOUNDS.driftWindowSize.step}
              bounds={BOUNDS.driftWindowSize}
              disabled={!canWrite || saving}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                disabled={!canWrite || saving}
                checked={!!draft.autoRetrainEnabled}
                onChange={(e) => setDraft({ ...draft, autoRetrainEnabled: e.target.checked })}
              />
              Auto-retrain enabled
            </label>
            <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Training mode
              <select
                disabled={!canWrite || saving}
                value={draft.trainingMode ?? 'FRESH'}
                onChange={(e) => setDraft({ ...draft, trainingMode: e.target.value })}
                style={{ padding: '4px 6px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'var(--color-input-bg, #fff)' }}
              >
                {TRAINING_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <Field
              label="Trees/round (10–500, CONTINUED only)"
              value={draft.continuedTreesPerRound}
              onChange={(v) => setDraft({ ...draft, continuedTreesPerRound: v })}
              step={BOUNDS.continuedTreesPerRound.step}
              bounds={BOUNDS.continuedTreesPerRound}
              disabled={!canWrite || saving || draft.trainingMode !== 'CONTINUED'}
            />
            <button
              className="btn-primary"
              disabled={!canWrite || !draftValid || !dirty || saving}
              onClick={save}
              style={btnStyle(canWrite && draftValid && dirty && !saving)}
              title={!canWrite ? 'Requires mla:configure permission' : ''}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </Row>

          <div style={{ marginTop: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Stat label="Effective F1" value={server.effective?.driftF1Threshold ?? '—'} />
            <Stat label="Effective PSI" value={server.effective?.driftPsiThreshold ?? '—'} />
            <Stat label="Effective window" value={server.effective?.driftWindowSize ?? '—'} />
            <Stat label="Training mode" value={server.trainingMode ?? 'FRESH'} />
            <Stat label="Trees/round" value={server.continuedTreesPerRound ?? 50} />
            <Stat label="Last drift check" value={fmtTime(server.last_drift_check_at)} />
            <Stat label="Last drift detected" value={fmtTime(server.last_drift_detected_at)} />
            <Stat label="Last retraining done" value={fmtTime(server.last_retraining_completed_at)} />
            <Stat label="Updated by" value={server.updatedBy || '—'} />
          </div>
        </>
      )}
    </Card>
  );
}

// ──────── Card 3: Manual retrain + history ───────────────────

function RetrainCard({ toast, canTrigger }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [triggering, setTriggering] = useState(false);
  // Expanded retrain-run id. Click a row to reveal the full A/B
  // breakdown — F1/AUC/precision/recall side-by-side, deltas, p-value,
  // and the validator's textual reasons. Only one row open at a time.
  const [expandedId, setExpandedId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await listRetrainRuns();
    setRuns(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const fire = async () => {
    setConfirming(false);
    setTriggering(true);
    try {
      await triggerManualRetrain();
      toast && toast('Retrain started');
      setTimeout(refresh, 800);
    } catch (err) {
      const msg = err.message || 'unknown error';
      if (msg.includes('409')) toast && toast('Retrain already in flight');
      else toast && toast(`Retrain failed to start: ${msg.slice(0, 80)}`);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <Card title="Retrain control" subtitle="Manually trigger an XGBoost retrain. Same pipeline as drift-triggered runs: ~30s on the dev workstation; promotes only if McNemar p < 0.05 and ΔF1 ≥ 0.01.">
      <Help>
        <p>
          Use this when you've added labelled data and want the model to learn it now rather than waiting for drift to fire. Or when you've changed the feature catalogue / overlay and need the deployed model in sync.
        </p>
        <p style={{ marginTop: 6 }}>
          The button is rate-limited server-side: a second click while a run is in-flight returns <code>409</code>. The runs list refreshes every 8s while this page is open.
        </p>
      </Help>

      <div style={{ marginBottom: 12 }}>
        <button
          className="btn-primary"
          disabled={!canTrigger || triggering}
          onClick={() => setConfirming(true)}
          style={btnStyle(canTrigger && !triggering)}
          title={!canTrigger ? 'Requires mla:configure permission' : ''}
        >
          {triggering ? 'Starting…' : 'Retrain now'}
        </button>
      </div>

      {/* Stale-while-revalidate: the 8s poll re-runs `refresh` and used
          to flip the whole table to "Loading…" each time. Now the
          placeholder only renders when there's nothing to keep visible,
          and the existing rows stay on screen across refetches. */}
      {loading && runs.length === 0 && <Muted>Loading run history…</Muted>}
      {!loading && runs.length === 0 && <Muted>No retrain runs yet.</Muted>}
      {runs.length > 0 && (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border-default)' }}>
              <Th style={{ width: 22 }}></Th>
              <Th>Started</Th>
              <Th>Trigger</Th>
              <Th>By</Th>
              <Th>Status</Th>
              <Th>Model</Th>
              <Th>F1</Th>
              <Th>AUC</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const isOpen = expandedId === r.id;
              // Any run carries either an `ab_test` blob (deployed or
              // rejected runs) or a `failureReason`. We expose the
              // chevron only when there's something worth expanding.
              const expandable = !!(r.metrics?.ab_test || r.failureReason);
              const toggle = () => {
                if (!expandable) return;
                setExpandedId((id) => (id === r.id ? null : r.id));
              };
              return (
                <React.Fragment key={r.id}>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--color-border-subtle)',
                      cursor: expandable ? 'pointer' : 'default',
                      background: isOpen ? 'var(--color-background-secondary)' : 'transparent',
                    }}
                    onClick={toggle}
                    title={expandable ? 'Click for A/B breakdown' : ''}
                  >
                    <Td>
                      {expandable && (
                        <Ti
                          name={isOpen ? 'chevron-down' : 'chevron-right'}
                          size={12}
                          style={{ color: 'var(--color-text-tertiary)' }}
                        />
                      )}
                    </Td>
                    <Td mono>{fmtTime(r.startedAt)}</Td>
                    <Td>{r.trigger}</Td>
                    <Td>{r.triggeredBy || '—'}</Td>
                    <Td><StatusPill status={r.status} /></Td>
                    <Td mono>{r.modelVersion || '—'}</Td>
                    <Td mono>{r.metrics?.f1_score?.toFixed?.(3) ?? '—'}</Td>
                    <Td mono>{r.metrics?.auc_roc?.toFixed?.(3) ?? '—'}</Td>
                    <Td style={{ color: 'var(--color-text-secondary)' }}>
                      {summariseReason(r)}
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: 'var(--color-background-secondary)' }}>
                      <td />
                      <td colSpan={8} style={{ padding: '8px 14px 14px' }}>
                        <RetrainRunDetails run={r} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {confirming && (
        <ConfirmModal
          title="Trigger retrain?"
          body="A new XGBoost model will be trained on the latest labelled rows. The candidate replaces the active model ONLY if McNemar p < 0.05 and ΔF1 ≥ 0.01 — otherwise the current model stays. Estimated time: ~30s. Continue?"
          onConfirm={fire}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

// ──────── Tiny presentational helpers ────────────────────────

function Card({ title, subtitle, children }) {
  return (
    <section className="card" style={{ padding: 16, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
      {subtitle && <p style={{ margin: '4px 0 12px', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>{subtitle}</p>}
      {children}
    </section>
  );
}

function Help({ children }) {
  return (
    <details style={{ marginBottom: 12 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--color-text-info)' }}>What do these mean?</summary>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{children}</div>
    </details>
  );
}

function Row({ children }) {
  return <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>{children}</div>;
}

function Field({ label, value, onChange, step, bounds, disabled }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        min={bounds.min}
        max={bounds.max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '6px 8px',
          fontSize: 13,
          fontFamily: 'var(--font-mono, monospace)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 4,
          background: disabled ? 'var(--color-background-tertiary)' : 'var(--color-background-primary)',
          color: 'var(--color-text-primary)',
        }}
      />
    </label>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>{value}</div>
    </div>
  );
}

function Muted({ children }) {
  return <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{children}</p>;
}

function StatusPill({ status }) {
  const tones = {
    running:   { bg: 'var(--color-background-info)',    fg: 'var(--color-text-info)' },
    succeeded: { bg: 'var(--color-background-success)', fg: 'var(--color-text-success)' },
    failed:    { bg: 'var(--color-background-warning)', fg: 'var(--color-text-warning)' },
    rejected:  { bg: 'var(--color-background-tertiary)', fg: 'var(--color-text-secondary)' },
  };
  const c = tones[status] || tones.rejected;
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500, background: c.bg, color: c.fg }}>
      {status}
    </span>
  );
}

function Th({ children, style }) {
  return <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, ...style }}>{children}</th>;
}

function Td({ children, mono, style }) {
  return <td style={{ padding: '6px 8px', fontFamily: mono ? 'var(--font-mono, monospace)' : undefined, ...style }}>{children}</td>;
}

function btnStyle(active) {
  return {
    padding: '6px 14px',
    fontSize: 13,
    borderRadius: 4,
    border: '1px solid var(--color-border-info)',
    background: active ? 'var(--color-text-info)' : 'var(--color-background-tertiary)',
    color: active ? 'white' : 'var(--color-text-tertiary)',
    cursor: active ? 'pointer' : 'not-allowed',
  };
}

function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * One-line headline shown in the table's "Reason" column. Prefers the
 * server-provided `failureReason`; falls back to the validator's
 * `ab_test.decision`. Deployed runs have nothing useful to summarise.
 */
function summariseReason(run) {
  if (run.failureReason) return run.failureReason;
  const ab = run.metrics?.ab_test;
  if (ab?.decision && ab.decision !== 'DEPLOY_NEW_MODEL') {
    return ab.decision.replace(/_/g, ' ').toLowerCase();
  }
  return '';
}

/**
 * Expanded details for a single retrain row. Renders:
 *  - Plain-English explanation of `failureReason` / rejection
 *  - Side-by-side metric table (current vs candidate) with delta column
 *  - Validator's own textual reasons + p-value when present
 */
function RetrainRunDetails({ run }) {
  const ab = run.metrics?.ab_test || null;
  const a = ab?.model_a;
  const b = ab?.model_b;
  const improvements = ab?.improvements || {};
  const pValue = ab?.p_value;
  const isSignificant = !!ab?.is_significant;
  const decision = ab?.decision;
  const reasons = Array.isArray(ab?.reasons) ? ab.reasons : [];

  return (
    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
      {run.failureReason && (
        <div
          style={{
            padding: '8px 10px',
            marginBottom: ab ? 10 : 0,
            background: 'var(--color-background-warning)',
            color: 'var(--color-text-warning)',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <strong>Why this run didn't deploy:</strong> {run.failureReason}
        </div>
      )}

      {ab && a && b && (
        <>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            A/B test — current production vs new candidate (held-out test set)
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border-default)' }}>
                <Th>Metric</Th>
                <Th>Current</Th>
                <Th>Candidate</Th>
                <Th>Δ</Th>
              </tr>
            </thead>
            <tbody>
              <MetricRow label="F1"        a={a.f1_score}   b={b.f1_score}   d={improvements.f1_score} />
              <MetricRow label="AUC"       a={a.auc_roc}    b={b.auc_roc}    d={improvements.auc_roc} />
              <MetricRow label="Precision" a={a.precision}  b={b.precision}  d={(b.precision ?? 0) - (a.precision ?? 0)} />
              <MetricRow label="Recall"    a={a.recall}     b={b.recall}     d={(b.recall ?? 0) - (a.recall ?? 0)} />
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8, fontSize: 12 }}>
            <span>
              <strong>Decision:</strong>{' '}
              <code className="mono">{decision || '—'}</code>
            </span>
            <span>
              <strong>p-value:</strong>{' '}
              <code className="mono">
                {typeof pValue === 'number' ? pValue.toFixed(4) : '—'}
              </code>{' '}
              {typeof pValue === 'number' && (
                <em style={{ color: 'var(--color-text-tertiary)' }}>
                  ({isSignificant ? 'significant' : 'not significant'} at p &lt; 0.05)
                </em>
              )}
            </span>
          </div>

          {reasons.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                Validator notes
              </div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {reasons.map((r, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {!ab && !run.failureReason && (
        <Muted>No A/B comparison recorded for this run.</Muted>
      )}
    </div>
  );
}

function MetricRow({ label, a, b, d }) {
  const sign = typeof d === 'number' && d > 0 ? '+' : '';
  const tone =
    typeof d !== 'number'
      ? 'var(--color-text-tertiary)'
      : d > 0
      ? 'var(--color-text-success)'
      : d < 0
      ? 'var(--color-text-danger)'
      : 'var(--color-text-tertiary)';
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(4) : '—');
  return (
    <tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <Td>{label}</Td>
      <Td mono>{fmt(a)}</Td>
      <Td mono>{fmt(b)}</Td>
      <Td mono style={{ color: tone }}>
        {typeof d === 'number' ? `${sign}${d.toFixed(4)}` : '—'}
      </Td>
    </tr>
  );
}

function ConfirmModal({ title, body, onConfirm, onCancel }) {
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 90vw)', padding: 20, borderRadius: 8,
          background: 'var(--color-background-primary)', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{title}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} style={{ padding: '6px 12px', fontSize: 13, borderRadius: 4, border: '1px solid var(--color-border-default)', background: 'transparent', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ padding: '6px 12px', fontSize: 13, borderRadius: 4, border: '1px solid var(--color-border-info)', background: 'var(--color-text-info)', color: 'white', cursor: 'pointer' }}>
            Trigger retrain
          </button>
        </div>
      </div>
    </div>
  );
}
