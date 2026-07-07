// Searchable, category-grouped variable picker for the rule builder.
// Replaces the flat ~80-option native <select>: request-context fields
// and every feature.<name> from the live catalogue, grouped by category
// with a type-to-filter box. Falls back to showing an unrecognised
// current value at the top so hand-authored rules stay editable.
//
// Styling uses the shared design tokens (src/tokens.css) so it adapts to
// the active light/dark theme — no hardcoded colours.

import { useEffect, useMemo, useRef, useState } from 'react';

function useOutsideClose(ref, onClose) {
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onClose]);
}

export function VarPicker({ value, groups, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  useOutsideClose(wrapRef, () => setOpen(false));

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  const known = useMemo(() => new Set(groups.flatMap((g) => g.items)), [groups]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups
      .map((g) => ({ ...g, items: needle ? g.items.filter((v) => v.toLowerCase().includes(needle)) : g.items }))
      .filter((g) => g.items.length > 0);
  }, [groups, q]);

  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };
  const unknownValue = value && !known.has(value);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        className="mono"
        onClick={() => setOpen((o) => !o)}
        title={value}
        style={{
          width: '100%', textAlign: 'left', fontSize: 11, padding: '4px 8px',
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--surface-alt)',
          color: unknownValue ? 'var(--color-text-warning)' : 'var(--color-text-primary)',
          cursor: disabled ? 'default' : 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {value || '—'}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', zIndex: 40, top: 'calc(100% + 4px)', left: 0, width: 'min(340px, 88vw)',
            maxHeight: 320, overflowY: 'auto',
            background: 'var(--surface-raised)', color: 'var(--color-text-primary)',
            border: '1px solid var(--border)', borderRadius: 6, boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ position: 'sticky', top: 0, padding: 6, background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter variables…"
              className="mono"
              style={{ width: '100%', fontSize: 11, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--color-text-primary)' }}
            />
          </div>

          {unknownValue && (
            <button type="button" className="mono" onClick={() => pick(value)} style={rowStyle(true)}>
              {value} <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>· current (not in catalogue)</span>
            </button>
          )}

          {filtered.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--color-text-tertiary)' }}>No variables match “{q}”.</div>
          )}

          {filtered.map((g) => (
            <div key={g.label}>
              <div style={{ padding: '6px 10px 3px', fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>{g.label}</div>
              {g.items.map((v) => (
                <button key={v} type="button" className="mono" onClick={() => pick(v)} style={rowStyle(v === value)}>
                  {v}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function rowStyle(active) {
  return {
    display: 'block', width: '100%', textAlign: 'left', fontSize: 11, padding: '5px 12px',
    border: 'none', background: active ? 'var(--color-background-secondary)' : 'transparent',
    color: 'var(--color-text-primary)', cursor: 'pointer',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
}

export default VarPicker;
