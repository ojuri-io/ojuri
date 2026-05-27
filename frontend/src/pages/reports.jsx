// Reports — operator-defined saved views over an existing data source
// (currently the decision audit log). Each row persists
//   { name, description, dataSource, filters, columns }
// so analysts can re-run the same query later and export the result
// without re-keying the filter set. Filters are the same shape the
// audit list endpoint already accepts; columns are projected
// server-side before CSV/JSON serialisation.

import { useEffect, useMemo, useState } from 'react';
import { Ti, PageHead, Modal, permLock } from '../components/shell.jsx';
import { DateTimePicker } from '../components/date-time-picker.jsx';
import { Pagination, paginate } from '../components/pagination.jsx';
import {
  listSavedReports,
  savedReportsCatalogue,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
  runSavedReport,
  exportSavedReport,
} from '../api/client.js';

const REPORTS_PER_PAGE = 10;

const DEFAULT_COLUMNS = [
  'createdAt',
  'transactionId',
  'senderId',
  'amount',
  'championScore',
  'finalDecision',
  'reasonCodes',
];

const DECISIONS = ['ACCEPT', 'DECLINE', 'REVIEW'];

function emptyDraft() {
  return {
    id: null,
    name: '',
    description: '',
    dataSource: 'audit',
    filters: {
      from: '',
      to: '',
      decision: [],
      modelVersion: '',
      reasonCodes: [],
      search: '',
      overridden: false,
      pending: false,
    },
    columns: [...DEFAULT_COLUMNS],
  };
}

function Reports({ toast, user }) {
  const [reports, setReports] = useState([]);
  const [catalogue, setCatalogue] = useState({ audit: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null); // when truthy, modal is open
  const [preview, setPreview] = useState(null); // { rows, total, columns } | null
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [page, setPage] = useState(1);

  const refresh = () =>
    listSavedReports().then((rows) => {
      if (Array.isArray(rows)) setReports(rows);
    });

  useEffect(() => {
    refresh();
    savedReportsCatalogue()
      .then((res) => {
        const map = {};
        for (const s of res?.sources || []) map[s.id] = s.columns || [];
        setCatalogue(map);
      })
      .catch(() => {
        /* empty catalogue is fine — column picker just won't render anything */
      });
  }, []);

  const selected = useMemo(
    () => reports.find((r) => r.id === selectedId) || null,
    [reports, selectedId],
  );

  // Client-paged: the saved-report list endpoint returns the full
  // collection (no row-cap server-side), so we slice locally.
  // Clamp page when the dataset shrinks (delete, refresh) so we don't
  // strand the user on an out-of-range empty page.
  useEffect(() => {
    const last = Math.max(1, Math.ceil(reports.length / REPORTS_PER_PAGE));
    if (page > last) setPage(last);
  }, [reports.length, page]);
  const pageRows = useMemo(
    () => paginate(reports, page, REPORTS_PER_PAGE),
    [reports, page],
  );

  // Available columns for the currently-edited data source. The picker
  // is built from this so adding new data sources server-side is enough.
  const availableColumns = useMemo(() => {
    if (!draft) return [];
    return catalogue[draft.dataSource] || [];
  }, [draft, catalogue]);

  const openCreate = () => {
    setDraft(emptyDraft());
  };

  const openEdit = (row) => {
    setDraft({
      id: row.id,
      name: row.name || '',
      description: row.description || '',
      dataSource: row.dataSource || 'audit',
      filters: {
        from: row.filters?.from || '',
        to: row.filters?.to || '',
        decision: Array.isArray(row.filters?.decision) ? row.filters.decision : [],
        modelVersion: row.filters?.modelVersion || '',
        reasonCodes: Array.isArray(row.filters?.reasonCodes) ? row.filters.reasonCodes : [],
        search: row.filters?.search || '',
        overridden: !!row.filters?.overridden,
        pending: !!row.filters?.pending,
      },
      columns: Array.isArray(row.columns) && row.columns.length ? [...row.columns] : [...DEFAULT_COLUMNS],
    });
  };

  const save = async () => {
    if (!draft?.name?.trim()) {
      toast('Name is required', 'error');
      return;
    }
    setSaving(true);
    const body = {
      name: draft.name.trim(),
      description: draft.description || undefined,
      dataSource: draft.dataSource,
      filters: stripEmpty(draft.filters),
      columns: draft.columns,
    };
    try {
      if (draft.id) {
        await updateSavedReport(draft.id, body);
        toast('Report updated', 'success');
      } else {
        const created = await createSavedReport(body);
        if (created?.id) setSelectedId(created.id);
        toast('Report saved', 'success');
      }
      await refresh();
      setDraft(null);
    } catch (err) {
      toast(`Save failed: ${err?.message || err}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const run = async (row) => {
    if (!row) return;
    setRunning(true);
    setSelectedId(row.id);
    try {
      const res = await runSavedReport(row.id, { limit: 100 });
      setPreview(res || null);
    } catch (err) {
      toast(`Run failed: ${err?.message || err}`, 'error');
      setPreview(null);
    } finally {
      setRunning(false);
    }
  };

  const doExport = async (row, format) => {
    try {
      await exportSavedReport(row.id, { format });
      toast(`${format.toUpperCase()} downloaded`, 'success');
    } catch (err) {
      toast(`Export failed: ${err?.message || err}`, 'error');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteSavedReport(pendingDelete.id);
      toast('Report deleted', 'success');
      if (selectedId === pendingDelete.id) {
        setSelectedId(null);
        setPreview(null);
      }
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      toast(`Delete failed: ${err?.message || err}`, 'error');
    }
  };

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Insights']}
        title="Reports"
        sub="Saved views over the audit log · run on demand, export to CSV / JSON"
      >
        <button
          className="info-bg"
          onClick={openCreate}
          {...permLock(user, 'saved_reports:write')}
        >
          <Ti name="plus" size={14} />
          New report
        </button>
      </PageHead>

      <section className="panel" style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
        <div
          className="row-grid header"
          style={{
            gridTemplateColumns: '1.4fr 1fr 80px 70px 220px',
            padding: 'calc(var(--row-pad-y, 9px) * 0.7) 14px',
            background: 'var(--color-background-secondary)',
          }}
        >
          <span>NAME</span>
          <span>SOURCE / DESCRIPTION</span>
          <span>COLUMNS</span>
          <span>UPDATED</span>
          <span style={{ justifySelf: 'end' }}>ACTIONS</span>
        </div>
        {reports.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No saved reports yet. Click <strong>New report</strong> to create one.
          </div>
        )}
        {pageRows.map((r) => (
          <div
            key={r.id}
            className="row-grid hoverable"
            style={{
              gridTemplateColumns: '1.4fr 1fr 80px 70px 220px',
              padding: 'var(--row-pad-y, 9px) 14px',
              alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{r.name}</div>
              <div className="mono truncate" style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {r.id}
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11 }}>
                <span className="pill info" style={{ fontSize: 9, padding: '1px 6px', marginRight: 6 }}>
                  {r.dataSource}
                </span>
                {r.description || <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
              </div>
            </div>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {Array.isArray(r.columns) ? r.columns.length : 0}
            </span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
              {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}
            </span>
            <div style={{ display: 'flex', gap: 4, justifySelf: 'end', flexWrap: 'wrap' }}>
              <button style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => run(r)}>
                <Ti name="player-play" size={11} />
                Run
              </button>
              <button style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => doExport(r, 'csv')} {...permLock(user, 'saved_reports:export')}>
                <Ti name="file-type-csv" size={11} />
                CSV
              </button>
              <button style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => doExport(r, 'json')} {...permLock(user, 'saved_reports:export')}>
                <Ti name="braces" size={11} />
                JSON
              </button>
              <button style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(r)} {...permLock(user, 'saved_reports:write')}>
                <Ti name="pencil" size={11} />
              </button>
              <button
                style={{ fontSize: 11, padding: '4px 8px' }}
                onClick={() => setPendingDelete(r)}
                {...permLock(user, 'saved_reports:write')}
              >
                <Ti name="trash" size={11} />
              </button>
            </div>
          </div>
        ))}
      </section>

      <Pagination
        page={page}
        pageSize={REPORTS_PER_PAGE}
        total={reports.length}
        onChange={setPage}
        variant="compact"
      />

      {/* Preview pane — shows the rows returned by the most-recent run. */}
      {preview && selected && (
        <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '0.5px solid var(--color-border-tertiary)',
              background: 'var(--color-background-secondary)',
            }}
          >
            <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-secondary)' }}>
              <strong>{selected.name}</strong> · {preview.rows.length} of {preview.total} rows
              {running && <span style={{ marginLeft: 8 }}>(running…)</span>}
            </p>
            <button style={{ fontSize: 11, padding: '3px 7px' }} onClick={() => setPreview(null)}>
              <Ti name="x" size={11} />
              Close preview
            </button>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 480 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {preview.columns.map((c) => (
                    <th
                      key={c}
                      style={{
                        textAlign: 'left',
                        padding: '7px 10px',
                        borderBottom: '0.5px solid var(--color-border-tertiary)',
                        position: 'sticky',
                        top: 0,
                        background: 'var(--color-background-secondary)',
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    {preview.columns.map((c) => (
                      <td key={c} style={{ padding: '6px 10px', verticalAlign: 'top', whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {fmtCell(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                Run returned 0 rows.
              </div>
            )}
          </div>
        </section>
      )}

      {/* Editor modal */}
      {draft && (
        <Modal
          title={draft.id ? `Edit · ${draft.name || 'untitled'}` : 'New report'}
          onClose={() => setDraft(null)}
          footer={
            <>
              <button onClick={() => setDraft(null)}>Cancel</button>
              <button className="info-bg" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create report'}
              </button>
            </>
          }
        >
          <Editor draft={draft} setDraft={setDraft} availableColumns={availableColumns} />
        </Modal>
      )}

      {/* Delete confirmation */}
      {pendingDelete && (
        <Modal
          title="Delete saved report?"
          onClose={() => setPendingDelete(null)}
          footer={
            <>
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger-bg" onClick={confirmDelete}>
                Delete
              </button>
            </>
          }
        >
          <p style={{ fontSize: 12 }}>
            Delete <strong>{pendingDelete.name}</strong>? This removes the saved
            definition. Any CSV/JSON exports you've already downloaded are not affected.
          </p>
        </Modal>
      )}
    </>
  );
}

function Editor({ draft, setDraft, availableColumns }) {
  const setFilter = (key, value) => {
    setDraft((d) => ({ ...d, filters: { ...d.filters, [key]: value } }));
  };
  const toggleDecision = (v) => {
    setDraft((d) => {
      const set = new Set(d.filters.decision);
      if (set.has(v)) set.delete(v);
      else set.add(v);
      return { ...d, filters: { ...d.filters, decision: [...set] } };
    });
  };
  const toggleCol = (c) => {
    setDraft((d) => {
      const set = new Set(d.columns);
      if (set.has(c)) set.delete(c);
      else set.add(c);
      // Preserve canonical column order (matches catalogue ordering)
      const ordered = availableColumns.filter((x) => set.has(x));
      return { ...d, columns: ordered };
    });
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="e.g. High-value declines, 24h"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Data source">
          <select
            value={draft.dataSource}
            onChange={(e) => setDraft((d) => ({ ...d, dataSource: e.target.value }))}
            style={{ width: '100%' }}
            disabled
            title="Only `audit` is wired today — more sources land in a later release."
          >
            <option value="audit">audit (decisionAuditLog)</option>
          </select>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="What this report answers — shown on the list view."
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
        />
      </Field>

      <fieldset style={{ border: '0.5px solid var(--color-border-tertiary)', padding: 10, borderRadius: 6 }}>
        <legend style={{ fontSize: 10, color: 'var(--color-text-tertiary)', padding: '0 6px' }}>FILTERS</legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="From">
            <DateTimePicker
              value={draft.filters.from}
              onChange={(v) => setFilter('from', v)}
              placeholder="dd mmm yyyy, hh:mm"
            />
          </Field>
          <Field label="To">
            <DateTimePicker
              value={draft.filters.to}
              onChange={(v) => setFilter('to', v)}
              placeholder="dd mmm yyyy, hh:mm"
              align="right"
            />
          </Field>
        </div>

        <Field label="Decision">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {DECISIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={draft.filters.decision.includes(d) ? 'info-bg' : ''}
                onClick={() => toggleDecision(d)}
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                {d}
              </button>
            ))}
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Model version">
            <input
              value={draft.filters.modelVersion}
              onChange={(e) => setFilter('modelVersion', e.target.value)}
              placeholder="e.g. v1.2.0"
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="Reason codes (comma-separated)">
            <input
              value={(draft.filters.reasonCodes || []).join(',')}
              onChange={(e) =>
                setFilter(
                  'reasonCodes',
                  e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
              placeholder="AMT_HIGH, VEL_OUTLIER"
              style={{ width: '100%' }}
            />
          </Field>
        </div>

        <Field label="Search (transactionId / senderId / receiverId substring)">
          <input
            value={draft.filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            style={{ width: '100%' }}
          />
        </Field>

        <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <input
              type="checkbox"
              checked={draft.filters.overridden}
              onChange={(e) => setFilter('overridden', e.target.checked)}
            />
            Was overridden
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <input
              type="checkbox"
              checked={draft.filters.pending}
              onChange={(e) => setFilter('pending', e.target.checked)}
            />
            Pending review only
          </label>
        </div>
      </fieldset>

      <fieldset style={{ border: '0.5px solid var(--color-border-tertiary)', padding: 10, borderRadius: 6 }}>
        <legend style={{ fontSize: 10, color: 'var(--color-text-tertiary)', padding: '0 6px' }}>
          COLUMNS · {draft.columns.length} selected
        </legend>
        {availableColumns.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            Column catalogue unavailable — using default selection.
          </p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {availableColumns.map((c) => {
              const active = draft.columns.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCol(c)}
                  className={active ? 'info-bg' : ''}
                  style={{ fontSize: 11, padding: '3px 8px', fontFamily: 'var(--font-mono)' }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <p className="label-up" style={{ margin: '0 0 4px' }}>{label}</p>
      {children}
    </label>
  );
}

function stripEmpty(filters) {
  const out = {};
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  if (Array.isArray(filters.decision) && filters.decision.length) out.decision = filters.decision;
  if (filters.modelVersion) out.modelVersion = filters.modelVersion;
  if (Array.isArray(filters.reasonCodes) && filters.reasonCodes.length) out.reasonCodes = filters.reasonCodes;
  if (filters.search) out.search = filters.search;
  if (filters.overridden) out.overridden = true;
  if (filters.pending) out.pending = true;
  return out;
}

function fmtCell(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    try {
      return new Date(v).toLocaleString();
    } catch {
      return v;
    }
  }
  return String(v);
}

export default Reports;
