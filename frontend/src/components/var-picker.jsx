// Searchable, category-grouped variable picker for the rule builder.
// Replaces the flat ~80-option native <select>: request-context fields
// and every feature.<name> from the live catalogue, grouped by category
// with a type-to-filter box. Falls back to showing an unrecognised
// current value at the top so hand-authored rules stay editable.

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
          border: '1px solid var(--color-border, rgba(255,255,255,0.15))', borderRadius: 4,
          background: 'var(--color-background-secondary, rgba(255,255,255,0.04))',
          color: known.has(value) ? 'inherit' : 'var(--color-text-warning, #d8a24a)',
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
            background: 'var(--color-background-elevated, #1c1e24)',
            border: '1px solid var(--color-border, rgba(255,255,255,0.15))', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ position: 'sticky', top: 0, padding: 6, background: 'inherit', borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.1))' }}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter variables…"
              className="mono"
              style={{ width: '100%', fontSize: 11, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--color-border, rgba(255,255,255,0.15))', background: 'var(--color-background-secondary, rgba(0,0,0,0.25))', color: 'inherit' }}
            />
          </div>

          {!known.has(value) && value && (
            <button type="button" className="mono" onClick={() => pick(value)}
              style={rowStyle(true)}>
              {value} <span style={{ opacity: 0.6, fontStyle: 'italic' }}>· current (not in catalogue)</span>
            </button>
          )}

          {filtered.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, opacity: 0.6 }}>No variables match “{q}”.</div>
          )}

          {filtered.map((g) => (
            <div key={g.label}>
              <div style={{ padding: '6px 10px 3px', fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.5 }}>{g.label}</div>
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
    border: 'none', background: active ? 'var(--color-background-active, rgba(120,150,255,0.16))' : 'transparent',
    color: 'inherit', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
}

export default VarPicker;
