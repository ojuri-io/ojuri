// Browser-side CSV preview + chunked upload.
//
// 1. User picks a CSV.
// 2. PapaParse reads the first PREVIEW_ROWS rows in the browser.
// 3. We surface column coverage (required present? optional?) and a
//    sample table so the operator validates the right data before
//    paying for the upload.
// 4. On Upload click: POST /init → PUT /chunk × N (sequential) →
//    POST /complete → toast + caller refreshes the jobs list.

import { useState, useRef } from 'react';
import Papa from 'papaparse';
import { Ti } from '../components/shell.jsx';
import {
  initTrainingUpload,
  putTrainingUploadChunk,
  completeTrainingUpload,
  abandonTrainingUpload,
} from '../api/client.js';

const PREVIEW_ROWS = 50;
const REQUIRED_COLS = [
  'transactionId', 'senderId', 'receiverId', 'amount', 'transactionType', 'timestamp',
];
const LABEL_COLS = ['groundTruthFraud', 'fraudLabel'];
const OPTIONAL_COLS = [
  'channel', 'currency', 'accountAgeDays', 'ipCountry', 'transactionCountry',
  'sessionToTxnSeconds', 'deviceIsTrusted', 'isAuthenticated',
];

function downloadTemplate() {
  const headers = [...REQUIRED_COLS, LABEL_COLS[0], ...OPTIONAL_COLS];
  const csv = headers.join(',') + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ojuri-training-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function TrainingUploadPanel({ toast, onCompleted }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [previewError, setPreviewError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [headerMap, setHeaderMap] = useState({});
  const [columnDefaults, setColumnDefaults] = useState({});
  const [dropEmptyRows, setDropEmptyRows] = useState(true);

  // Effective column set after applying headerMap. The mapping renames
  // a source column (left) to a canonical name (right) so a CSV with
  // `txn_id` can satisfy the `transactionId` requirement.
  const mappedColumns = columns.map((c) => headerMap[c] || c);
  const allKnownCanonical = new Set([...mappedColumns, ...Object.keys(columnDefaults)]);
  const requiredMissing = file
    ? REQUIRED_COLS.filter((c) => !allKnownCanonical.has(c))
    : [];
  const hasLabel = file && LABEL_COLS.some((c) => allKnownCanonical.has(c));
  const ready = file && requiredMissing.length === 0 && hasLabel;

  const reset = () => {
    setFile(null);
    setColumns([]);
    setRows([]);
    setPreviewError(null);
    setProgress(0);
    setHeaderMap({});
    setColumnDefaults({});
    setDropEmptyRows(true);
    if (fileRef.current) fileRef.current.value = '';
  };

  const setMapping = (sourceCol, canonicalCol) => {
    setHeaderMap((prev) => {
      const next = { ...prev };
      if (canonicalCol) next[sourceCol] = canonicalCol;
      else delete next[sourceCol];
      return next;
    });
  };

  const setDefault = (col, value) => {
    setColumnDefaults((prev) => {
      const next = { ...prev };
      if (value && value.trim()) next[col] = value.trim();
      else delete next[col];
      return next;
    });
  };

  const buildSpec = () => {
    const spec = {};
    if (Object.keys(headerMap).length > 0) spec.headerMap = headerMap;
    if (Object.keys(columnDefaults).length > 0) spec.columnDefaults = columnDefaults;
    spec.dropEmptyRows = dropEmptyRows;
    return spec;
  };

  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreviewError(null);
    setRows([]);
    setColumns([]);
    Papa.parse(f, {
      header: true,
      preview: PREVIEW_ROWS,
      skipEmptyLines: true,
      complete: (res) => {
        if (res.errors && res.errors.length > 0) {
          setPreviewError(res.errors[0].message);
        }
        const cols = res.meta?.fields || [];
        setColumns(cols);
        setRows((res.data || []).slice(0, PREVIEW_ROWS));
      },
      error: (err) => {
        setPreviewError(String(err?.message || err));
      },
    });
  };

  const upload = async () => {
    if (!file || !ready || uploading) return;
    setUploading(true);
    setProgress(0);
    let init;
    try {
      init = await initTrainingUpload({
        filename: file.name,
        expectedBytes: file.size,
      });
    } catch (err) {
      toast(`Init failed · ${String(err?.message || err)}`, 'danger');
      setUploading(false);
      return;
    }
    const chunkSize = init.chunkSize || 5 * 1024 * 1024;
    let offset = 0;
    try {
      while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const blob = file.slice(offset, end);
        const bytes = await blob.arrayBuffer();
        await putTrainingUploadChunk({ uploadId: init.uploadId, offset, bytes });
        offset = end;
        setProgress(Math.round((offset / file.size) * 100));
      }
      await completeTrainingUpload(init.uploadId, buildSpec());
      toast(`Uploaded ${file.name} · queued for import`, 'success');
      reset();
      onCompleted?.();
    } catch (err) {
      toast(`Upload failed · ${String(err?.message || err)}`, 'danger');
      try { await abandonTrainingUpload(init.uploadId); } catch { /* best-effort */ }
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="panel" style={{ marginBottom: 12, padding: '16px 18px' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 500 }}>Upload CSV</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Pick a labelled CSV. We preview the first {PREVIEW_ROWS} rows in your browser so you can
        verify the columns before sending it. The file uploads in {fmtBytes(5 * 1024 * 1024)} chunks
        — close the tab safely if anything looks off.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          ref={fileRef}
          data-testid="training-upload-input"
          type="file"
          accept=".csv,text/csv"
          onChange={onPick}
          disabled={uploading}
          style={{ fontSize: 12 }}
        />
        <button
          type="button"
          data-testid="training-download-template"
          onClick={downloadTemplate}
          style={{ fontSize: 11 }}
          title="Download an empty CSV with the canonical column names"
        >
          <Ti name="download" size={12} /> Download template
        </button>
        {file && (
          <button onClick={reset} disabled={uploading} style={{ fontSize: 11 }}>
            <Ti name="x" size={12} /> Clear
          </button>
        )}
      </div>

      {previewError && (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--color-text-danger)' }}>
          Preview error · {previewError}
        </p>
      )}

      {file && (
        <>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            <strong className="mono">{file.name}</strong> · {fmtBytes(file.size)} ·{' '}
            previewed {rows.length} row{rows.length === 1 ? '' : 's'}
          </div>

          <div style={{ marginBottom: 12, fontSize: 11 }}>
            <div style={{ marginBottom: 6 }}>
              <strong>Required:</strong>{' '}
              {REQUIRED_COLS.map((c) => (
                <span
                  key={c}
                  className="pill"
                  style={{
                    padding: '2px 7px',
                    marginRight: 4,
                    background: allKnownCanonical.has(c)
                      ? 'var(--color-background-success)'
                      : 'var(--color-background-danger)',
                    color: allKnownCanonical.has(c)
                      ? 'var(--color-text-success)'
                      : 'var(--color-text-danger)',
                  }}
                  data-testid={`col-${c}`}
                >
                  {allKnownCanonical.has(c) ? '✓' : '✗'} {c}
                </span>
              ))}
            </div>
            <div style={{ marginBottom: 6 }}>
              <strong>Label (one of):</strong>{' '}
              {LABEL_COLS.map((c) => (
                <span
                  key={c}
                  className="pill"
                  style={{
                    padding: '2px 7px',
                    marginRight: 4,
                    background: allKnownCanonical.has(c)
                      ? 'var(--color-background-success)'
                      : 'var(--color-background-secondary)',
                  }}
                >
                  {allKnownCanonical.has(c) ? '✓' : '○'} {c}
                </span>
              ))}
            </div>
            <div>
              <strong>Optional present:</strong>{' '}
              {OPTIONAL_COLS.filter((c) => allKnownCanonical.has(c)).map((c) => (
                <span key={c} className="pill" style={{ padding: '2px 7px', marginRight: 4 }}>{c}</span>
              )) || <em style={{ color: 'var(--color-text-tertiary)' }}>none</em>}
            </div>
          </div>

          {!ready && file && (
            <details open style={{ marginBottom: 12, fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 500, marginBottom: 8 }}>
                Fix columns without re-exporting · map headers or set defaults
              </summary>
              {requiredMissing.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 6, color: 'var(--color-text-secondary)' }}>
                    Match a source column to each missing canonical column, OR provide a default value
                    that the same value will be written into every row.
                  </div>
                  {requiredMissing.map((needed) => (
                    <div
                      key={needed}
                      style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: 8, alignItems: 'center', marginBottom: 4 }}
                    >
                      <span className="mono" style={{ color: 'var(--color-text-danger)' }}>{needed}</span>
                      <select
                        data-testid={`map-${needed}`}
                        value={Object.entries(headerMap).find(([, v]) => v === needed)?.[0] || ''}
                        onChange={(e) => {
                          const prev = Object.entries(headerMap).find(([, v]) => v === needed)?.[0];
                          if (prev) setMapping(prev, '');
                          if (e.target.value) setMapping(e.target.value, needed);
                        }}
                        style={{ fontSize: 11, padding: '4px 6px' }}
                      >
                        <option value="">— map from source column —</option>
                        {columns
                          .filter((c) => !mappedColumns.includes(c) || c === Object.entries(headerMap).find(([, v]) => v === needed)?.[0])
                          .map((c) => (<option key={c} value={c}>{c}</option>))}
                      </select>
                      <input
                        data-testid={`default-${needed}`}
                        type="text"
                        placeholder={`or default value for ${needed}`}
                        value={columnDefaults[needed] || ''}
                        onChange={(e) => setDefault(needed, e.target.value)}
                        style={{ fontSize: 11, padding: '4px 6px' }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <div style={{ marginBottom: 6, fontWeight: 500 }}>Optional defaults</div>
                <div style={{ color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  Fill any optional column with a single value applied to all rows (useful when the
                  source file doesn't have it).
                </div>
                {OPTIONAL_COLS.filter((c) => !mappedColumns.includes(c)).map((c) => (
                  <div
                    key={c}
                    style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center', marginBottom: 4 }}
                  >
                    <span className="mono">{c}</span>
                    <input
                      data-testid={`default-opt-${c}`}
                      type="text"
                      placeholder={`default for ${c}`}
                      value={columnDefaults[c] || ''}
                      onChange={(e) => setDefault(c, e.target.value)}
                      style={{ fontSize: 11, padding: '4px 6px' }}
                    />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={dropEmptyRows}
                  onChange={(e) => setDropEmptyRows(e.target.checked)}
                />
                <span>Drop fully empty rows during import</span>
              </label>
            </details>
          )}

          {rows.length > 0 && (
            <div style={{ overflow: 'auto', maxHeight: 220, border: '1px solid var(--color-border)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: 'var(--color-background-secondary)', position: 'sticky', top: 0 }}>
                    {columns.map((c) => (
                      <th key={c} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 500 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                      {columns.map((c) => (
                        <td key={c} className="mono" style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>
                          {String(r[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {uploading && (
            <div style={{ marginTop: 12 }}>
              <div style={{ height: 6, background: 'var(--color-background-secondary)', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${progress}%`,
                    background: 'var(--color-text-info)',
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                Uploading · {progress}% · {fmtBytes(Math.round((progress / 100) * file.size))} of {fmtBytes(file.size)}
              </p>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              data-testid="training-upload-submit"
              onClick={upload}
              disabled={!ready || uploading}
            >
              <Ti name="upload" size={14} />
              {uploading ? `Uploading ${progress}%` : 'Upload and queue'}
            </button>
            {!ready && file && (
              <span style={{ fontSize: 11, color: 'var(--color-text-danger)' }}>
                {requiredMissing.length > 0
                  ? `Missing required columns: ${requiredMissing.join(', ')}`
                  : 'A label column (groundTruthFraud or fraudLabel) is required for training'}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default TrainingUploadPanel;
