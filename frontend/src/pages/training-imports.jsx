// Training data imports — adopter-facing page for backfilling labelled
// transactions into the platform. Lists submitted import jobs, lets
// operators submit a new file:// or s3:// source, and polls in-progress
// jobs every few seconds.

import { useState, useEffect, useCallback } from 'react';
import { Ti, PageHead, hasPermission } from '../components/shell.jsx';
import {
  listTrainingImports,
  createTrainingImport,
  promoteTrainingImport,
  triggerManualRetrain,
} from '../api/client.js';
import TrainingUploadPanel from './training-upload-panel.jsx';

const REFRESH_MS = 4000;

function StatusPill({ status }) {
  const tone =
    status === 'COMPLETED' ? 'success' :
    status === 'FAILED' ? 'danger' :
    status === 'RUNNING' ? 'info' : 'warn';
  return <span className={'pill ' + tone} style={{ padding: '3px 8px' }}>{status || '—'}</span>;
}

function TrainingImports({ toast, user }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [promotingId, setPromotingId] = useState(null);
  const [retrainingId, setRetrainingId] = useState(null);

  const onPromote = async (jobId) => {
    setPromotingId(jobId);
    try {
      const res = await promoteTrainingImport(jobId);
      toast(`Promoted ${res?.promotedRows ?? 0} rows into the training set`, 'success');
      refresh();
    } catch (err) {
      toast(`Promote failed · ${String(err?.message || err)}`, 'danger');
    } finally {
      setPromotingId(null);
    }
  };

  const onRetrain = async (jobId) => {
    setRetrainingId(jobId);
    try {
      await triggerManualRetrain();
      toast('Retrain triggered · McNemar guard will decide deployment', 'success');
    } catch (err) {
      toast(`Retrain failed to start · ${String(err?.message || err)}`, 'danger');
    } finally {
      setRetrainingId(null);
    }
  };

  const canWrite = hasPermission(user, 'training:write');

  const refresh = useCallback(async () => {
    const res = await listTrainingImports({ limit: 50 });
    setRows(Array.isArray(res?.rows) ? res.rows : []);
    setTotal(Number(res?.total) || 0);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const submit = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await createTrainingImport(trimmed);
      toast('Training import queued', 'success');
      setSource('');
      refresh();
    } catch (err) {
      toast(`Submission failed · ${String(err?.message || err)}`, 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Configuration']}
        title="Training data imports"
        sub={
          rows == null
            ? 'Loading…'
            : `${total} import${total === 1 ? '' : 's'} · polls every ${REFRESH_MS / 1000}s`
        }
      />

      {canWrite && <TrainingUploadPanel toast={toast} onCompleted={refresh} />}

      {canWrite && (
        <section className="panel" style={{ marginBottom: 12, padding: '14px 18px' }}>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              color: 'inherit',
            }}
            aria-expanded={advancedOpen}
          >
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Advanced · server-side path</h2>
            <Ti name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={14} style={{ color: 'var(--color-text-info)' }} />
          </button>
          {advancedOpen && (
            <div style={{ marginTop: 10 }}>
              <p style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                If the CSV is already on the RDA host (e.g. dropped into{' '}
                <code className="mono">data/training-imports/</code>), submit its path directly. Skips
                the browser upload. <code className="mono">s3://</code> sources return 501 today.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  data-testid="training-source-input"
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="file:///app/data/training-imports/labels.csv"
                  style={{ flex: 1, padding: '6px 10px', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                  disabled={submitting}
                />
                <button
                  data-testid="training-submit"
                  onClick={submit}
                  disabled={submitting || !source.trim()}
                >
                  <Ti name="terminal" size={14} />
                  Queue path
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="panel" style={{ padding: '14px 18px' }}>
        <div className="panel-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>Recent jobs</h2>
        </div>
        {rows == null ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No import jobs yet. {canWrite ? 'Submit one above to begin.' : 'Ask an operator with training:write to submit one.'}
          </p>
        ) : (
          <div className="row-grid" style={{ gridTemplateColumns: '110px 1fr 90px 90px 90px 140px 28px', fontSize: 11, color: 'var(--color-text-tertiary)', padding: '4px 0 6px' }}>
            <span>STATUS</span><span>SOURCE</span><span>READ</span><span>STAGED</span><span>REJECTED</span><span>CREATED</span><span></span>
          </div>
        )}
        {(rows || []).map((job) => (
          <div key={job.jobId}>
            <div
              className="row-grid hoverable"
              style={{
                gridTemplateColumns: '110px 1fr 90px 90px 90px 140px 28px',
                padding: '8px 0',
                cursor: 'pointer',
              }}
              onClick={() => setExpandedJobId(expandedJobId === job.jobId ? null : job.jobId)}
            >
              <StatusPill status={job.status} />
              <span className="truncate mono" style={{ fontSize: 11 }} title={job.source}>{job.source}</span>
              <span className="mono" style={{ fontSize: 11 }}>{job.rowsRead}</span>
              <span className="mono" style={{ fontSize: 11 }}>{job.rowsStaged}</span>
              <span className="mono" style={{ fontSize: 11, color: job.rowsRejected > 0 ? 'var(--color-text-danger)' : undefined }}>
                {job.rowsRejected}
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {new Date(job.createdAt).toLocaleString()}
              </span>
              <Ti name={expandedJobId === job.jobId ? 'chevron-up' : 'chevron-down'} size={14} style={{ color: 'var(--color-text-info)', justifySelf: 'end' }} />
            </div>
            {expandedJobId === job.jobId && (
              <div style={{ padding: '8px 12px 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <div><strong>Job id:</strong> <code className="mono">{job.jobId}</code></div>
                {job.startedAt && <div><strong>Started:</strong> {new Date(job.startedAt).toLocaleString()}</div>}
                {job.completedAt && <div><strong>Completed:</strong> {new Date(job.completedAt).toLocaleString()}</div>}
                {job.promotedAt && (
                  <div style={{ color: 'var(--color-text-success)' }}>
                    <strong>Promoted:</strong> {new Date(job.promotedAt).toLocaleString()}
                    {job.promotedRows != null && ` · ${job.promotedRows} rows into transactions`}
                    {job.promotedBy && ` · by ${job.promotedBy}`}
                  </div>
                )}
                {Array.isArray(job.errors) && job.errors.length > 0 && (
                  <details open style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--color-text-danger)' }}>
                      {job.errors.length} row error{job.errors.length === 1 ? '' : 's'}
                    </summary>
                    <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 11 }}>
                      {job.errors.slice(0, 25).map((err, i) => (
                        <li key={i}><strong>line {err.row}:</strong> {err.message}</li>
                      ))}
                      {job.errors.length > 25 && (
                        <li style={{ color: 'var(--color-text-tertiary)' }}>… and {job.errors.length - 25} more</li>
                      )}
                    </ul>
                  </details>
                )}

                {canWrite && job.status === 'COMPLETED' && (
                  <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {!job.promotedAt ? (
                      <button
                        data-testid={`promote-${job.jobId}`}
                        disabled={promotingId === job.jobId}
                        onClick={() => onPromote(job.jobId)}
                        title="Insert staged rows into the transactions table so MLA picks them up on its next train"
                      >
                        <Ti name="check" size={12} />
                        {promotingId === job.jobId ? 'Promoting…' : 'Promote to training set'}
                      </button>
                    ) : (
                      <button
                        data-testid={`retrain-${job.jobId}`}
                        disabled={retrainingId === job.jobId}
                        onClick={() => onRetrain(job.jobId)}
                        title="Trigger MLA retrain. McNemar's test gates the model swap as usual."
                      >
                        <Ti name="cpu" size={12} />
                        {retrainingId === job.jobId ? 'Triggering…' : 'Retrain now'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
    </>
  );
}

export default TrainingImports;
