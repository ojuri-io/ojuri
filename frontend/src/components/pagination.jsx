// Shared pagination bar — used by Audit log, Transactions, Reports,
// Users, and Investigations.
//
// Previous behaviour hid the entire footer when there was only one page
// of results — which made the count indicator disappear on short lists
// and made the dashboard feel inconsistent ("sometimes I see pagination,
// sometimes I don't"). It now ALWAYS renders the row when there's at
// least one row of data, and disables the chevrons when there's nothing
// to navigate. Empty lists still hide it (no row to count).
//
// Two visual flavours via `variant`:
//
//   - "numbered" — chevron + page numbers (1, 2, 3, … N). Matches what
//     Transactions used; preferred for client-paged lists where the
//     full count is known cheaply.
//   - "compact"  — chevron · "page / total" · chevron. Matches Audit
//     log; preferred when we only care about the current cursor.
//
// `paginate(rows, page, pageSize)` slices a client-side array so each
// caller doesn't reinvent the math.

import React from 'react';
import { Ti } from './shell.jsx';

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  variant = 'compact',
}) {
  // Nothing to show when the table is empty. Empty-state copy is the
  // page's responsibility — the footer would just say "0 of 0".
  if (!total || total <= 0) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to = Math.min(page * pageSize, total);
  const setPage = (n) => onChange(Math.max(1, Math.min(totalPages, n)));
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 4px 0',
        fontSize: 11,
        color: 'var(--color-text-secondary)',
      }}
    >
      <span>
        Showing {from}–{to} of {total}
      </span>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          style={{ fontSize: 11, padding: '4px 8px', minWidth: 28 }}
          disabled={atFirst}
          onClick={() => setPage(page - 1)}
          aria-label="Previous page"
        >
          <Ti name="chevron-left" size={12} />
        </button>
        {variant === 'numbered' ? (
          <NumberedPages page={page} totalPages={totalPages} setPage={setPage} />
        ) : (
          <span style={{ fontSize: 11, padding: '0 6px' }}>
            {page} / {totalPages}
          </span>
        )}
        <button
          style={{ fontSize: 11, padding: '4px 8px', minWidth: 28 }}
          disabled={atLast}
          onClick={() => setPage(page + 1)}
          aria-label="Next page"
        >
          <Ti name="chevron-right" size={12} />
        </button>
      </div>
    </div>
  );
}

function NumberedPages({ page, totalPages, setPage }) {
  // Always show pages 1..min(3, totalPages); ellipsis + last page when there's a gap.
  const lead = [1, 2, 3].filter((n) => n <= totalPages);
  const showTail = totalPages > 4;
  return (
    <>
      {lead.map((n) => (
        <button
          key={n}
          className={n === page ? 'info-bg' : ''}
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={() => setPage(n)}
        >
          {n}
        </button>
      ))}
      {showTail && (
        <>
          <span style={{ padding: '4px 4px', color: 'var(--color-text-tertiary)' }}>…</span>
          <button
            className={totalPages === page ? 'info-bg' : ''}
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => setPage(totalPages)}
          >
            {totalPages}
          </button>
        </>
      )}
    </>
  );
}

/** Helper for client-paged lists. Slices `rows` to the current page. */
export function paginate(rows, page, pageSize) {
  if (!Array.isArray(rows)) return [];
  return rows.slice((page - 1) * pageSize, page * pageSize);
}
