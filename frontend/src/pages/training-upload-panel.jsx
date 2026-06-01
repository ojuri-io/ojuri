// Browser-side CSV preview + chunked upload.
//
// 1. User picks a CSV.
// 2. PapaParse reads the first PREVIEW_ROWS rows in the browser.
// 3. We surface column coverage (required present? optional?) and a
//    sample table so the operator validates the right data before
//    paying for the upload.
// 4. On Upload click: POST /init → PUT /chunk × N (sequential) →
//    POST /complete → toast + caller refreshes the jobs list.

import { useState, useEffect, useRef } from 'react';
import Papa from 'papaparse';
import { Ti } from '../components/shell.jsx';
import {
  getState as getUploadState,
  subscribe as subscribeUpload,
  start as startUpload,
  reset as resetUpload,
} from '../state/training-upload-runner.js';

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

const ALL_CANONICAL = [...REQUIRED_COLS, ...LABEL_COLS, ...OPTIONAL_COLS];

function TrainingUploadPanel({ toast, onCompleted }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [previewError, setPreviewError] = useState(null);
  const [runner, setRunner] = useState(getUploadState);
  useEffect(() => subscribeUpload(setRunner), []);
  const uploading = runner.status === 'uploading' || runner.status === 'completing';
  const progress = runner.progress;
  const [headerMap, setHeaderMap] = useState({});
  const [columnDefaults, setColumnDefaults] = useState({});
  const [dropEmptyRows, setDropEmptyRows] = useState(true);
  const [editingCol, setEditingCol] = useState(null);

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
    setHeaderMap({});
    setColumnDefaults({});
    setDropEmptyRows(true);
    resetUpload();
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

  const upload = () => {
    if (!file || !ready || uploading) return;
    startUpload({
      file,
      spec: buildSpec(),
      onSuccess: () => {
        toast(`Uploaded ${file.name} · queued for import`, 'success');
        reset();
        onCompleted?.();
      },
      onError: (msg) => toast(`Upload failed · ${msg}`, 'danger'),
    });
  };

  return (
    <section className="panel" style={{ marginBottom: 12, padding: '16px 18px' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 500 }}>Upload CSV</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Pick a labelled CSV. We preview the first {PREVIEW_ROWS} rows in your browser so you can
        verify the columns before sending it. The file uploads in {fmtBytes(5 * 1024 * 1024)} chunks
        — close the tab safely if anything looks off.
      </p>

      {uploading && !file && (
        <div
          data-testid="training-upload-resumed"
          style={{
            marginBottom: 12, padding: '8px 10px', borderRadius: 4,
            background: 'var(--color-background-info)', color: 'var(--color-text-info)', fontSize: 12,
          }}
        >
          Upload of <strong className="mono">{runner.filename}</strong> is still running in the background — {progress}%.
          <div style={{ height: 6, background: 'var(--color-background-secondary)', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--color-text-info)', transition: 'width 200ms ease' }} />
          </div>
        </div>
      )}

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

          {file && (
            <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--color-text-secondary)' }}>
              Need to rename a column? <strong>Click any column header in the preview below</strong>{' '}
              to retype it (the rename applies to every row server-side). For missing optional
              columns, set a single default value applied to all rows.
            </p>
          )}

          {file && OPTIONAL_COLS.some((c) => !mappedColumns.includes(c)) && (
            <details style={{ marginBottom: 12, fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 500, marginBottom: 8 }}>
                Set default values for missing optional columns
              </summary>
              <div style={{ marginTop: 8 }}>
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
            </details>
          )}

          {file && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dropEmptyRows}
                onChange={(e) => setDropEmptyRows(e.target.checked)}
              />
              <span>Drop fully empty rows during import</span>
            </label>
          )}

          {rows.length > 0 && (
            <>
              <datalist id="canonical-columns">
                {ALL_CANONICAL.map((c) => (<option key={c} value={c} />))}
              </datalist>
              <div style={{ overflow: 'auto', maxHeight: 240, border: '1px solid var(--color-border)', borderRadius: 4 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-background-secondary)', position: 'sticky', top: 0 }}>
                      {columns.map((c) => {
                        const mapped = headerMap[c] || c;
                        const isCanonical = ALL_CANONICAL.includes(mapped);
                        const isRenamed = mapped !== c;
                        const isEditing = editingCol === c;
                        return (
                          <th key={c} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 500, minWidth: 110 }}>
                            {isEditing ? (
                              <input
                                autoFocus
                                list="canonical-columns"
                                defaultValue={mapped}
                                data-testid={`header-input-${c}`}
                                onBlur={(e) => {
                                  const next = e.target.value.trim();
                                  setMapping(c, next && next !== c ? next : '');
                                  setEditingCol(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                  if (e.key === 'Escape') { setEditingCol(null); }
                                }}
                                style={{ fontSize: 11, padding: '2px 4px', width: 130 }}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEditingCol(c)}
                                data-testid={`header-${c}`}
                                title={isRenamed ? `Renamed from "${c}"` : 'Click to rename'}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  cursor: 'pointer',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  color: isRenamed
                                    ? 'var(--color-text-success)'
                                    : isCanonical
                                    ? 'inherit'
                                    : 'var(--color-text-secondary)',
                                  textAlign: 'left',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 1,
                                }}
                              >
                                <span>{mapped}</span>
                                {isRenamed && (
                                  <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
                                    ← {c}
                                  </span>
                                )}
                              </button>
                            )}
                          </th>
                        );
                      })}
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
            </>
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
