// Brand-themed date+time picker.
//
// Drop-in replacement for `<input type="datetime-local">`. The value shape
// stays the same — "YYYY-MM-DDTHH:MM" or "" — so callsites change only by
// swapping the element. The popover is rendered in-flow (no portal); if a
// caller mounts this inside a clipping container, set `align="right"` to
// anchor the popover to the trigger's right edge.
//
// Why we don't use the native control: macOS Chrome paints the calendar
// popover with system blue and the `accent-color` CSS property doesn't
// reach the popover surface. The whole point of the Ojuri brand is staying
// out of accent palettes, so the native control is a brand miss.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Ti } from './shell.jsx';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Parse "YYYY-MM-DDTHH:MM" into { date: Date | null, time: { h, m } }.
// Tolerates missing time component (date-only inputs) and empty string.
function parseValue(v) {
  if (!v) return { date: null, time: null };
  const [d, t] = String(v).split('T');
  const [yy, mo, dd] = (d || '').split('-').map(Number);
  if (!yy || !mo || !dd) return { date: null, time: null };
  const date = new Date(yy, mo - 1, dd);
  const [hh, mm] = (t || '').split(':').map(Number);
  const time = Number.isFinite(hh) && Number.isFinite(mm) ? { h: hh, m: mm } : { h: 0, m: 0 };
  return { date, time };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatValue(date, time) {
  if (!date) return '';
  return (
    date.getFullYear() +
    '-' + pad2(date.getMonth() + 1) +
    '-' + pad2(date.getDate()) +
    'T' + pad2(time?.h ?? 0) + ':' + pad2(time?.m ?? 0)
  );
}

// Display string shown in the trigger. Stays compact: "21 May 2026, 14:22".
function formatDisplay(value) {
  const { date, time } = parseValue(value);
  if (!date) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getFullYear()}, ${pad2(time.h)}:${pad2(time.m)}`;
}

// Build the 6-row × 7-column grid of dates for `month`, starting Monday.
// Days outside the focused month carry an `outside` flag so they render
// muted but are still clickable (matches Notion / Linear behaviour).
function buildGrid(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // JS getDay: 0=Sun..6=Sat. Map to Mon-start: 0=Mon..6=Sun.
  const leadOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - leadOffset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, outside: d.getMonth() !== month.getMonth() });
  }
  return cells;
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function DateTimePicker({ value, onChange, placeholder = 'Select date', align = 'left', title }) {
  const [open, setOpen] = useState(false);
  const { date: selected, time: selectedTime } = useMemo(() => parseValue(value), [value]);
  const [viewMonth, setViewMonth] = useState(() => selected || new Date());
  const rootRef = useRef(null);

  // Re-anchor the visible month when the parent's value changes.
  useEffect(() => {
    if (selected) setViewMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [selected]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const grid = useMemo(() => buildGrid(viewMonth), [viewMonth]);
  const today = new Date();

  const commit = useCallback((date, time) => {
    onChange(formatValue(date, time || selectedTime || { h: 0, m: 0 }));
  }, [onChange, selectedTime]);

  const pickDay = (cell) => {
    commit(cell.date, selectedTime);
    if (cell.outside) {
      setViewMonth(new Date(cell.date.getFullYear(), cell.date.getMonth(), 1));
    }
  };

  const setTime = (which, raw) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    const next = { h: selectedTime?.h ?? 0, m: selectedTime?.m ?? 0 };
    if (which === 'h') next.h = Math.max(0, Math.min(23, n));
    else next.m = Math.max(0, Math.min(59, n));
    commit(selected || new Date(), next);
  };

  const display = formatDisplay(value);

  return (
    <div className="dtp" ref={rootRef}>
      <button
        type="button"
        className={'dtp-trigger' + (display ? '' : ' dtp-trigger--empty')}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="dtp-trigger-text">{display || placeholder}</span>
        <Ti name="layout-dashboard" size={14} style={{ display: 'none' }} />
        <span className="dtp-trigger-icon" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={'dtp-pop' + (align === 'right' ? ' dtp-pop--right' : '')} role="dialog">
          <header className="dtp-pop-head">
            <button type="button" className="dtp-nav" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
            <span className="dtp-pop-title">{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</span>
            <button type="button" className="dtp-nav" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month">›</button>
          </header>
          <div className="dtp-grid dtp-grid--weekdays">
            {WEEKDAYS.map((w) => <span key={w} className="dtp-weekday">{w[0]}</span>)}
          </div>
          <div className="dtp-grid">
            {grid.map((cell, i) => {
              const isSelected = sameDay(cell.date, selected);
              const isToday = sameDay(cell.date, today);
              const cls = ['dtp-day'];
              if (cell.outside) cls.push('dtp-day--outside');
              if (isSelected) cls.push('dtp-day--selected');
              if (isToday && !isSelected) cls.push('dtp-day--today');
              return (
                <button
                  key={i}
                  type="button"
                  className={cls.join(' ')}
                  onClick={() => pickDay(cell)}
                >
                  {cell.date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dtp-time">
            <span className="dtp-time-label">Time</span>
            <input
              type="text"
              inputMode="numeric"
              className="dtp-time-input"
              value={pad2(selectedTime?.h ?? 0)}
              onChange={(e) => setTime('h', e.target.value.replace(/\D/g, '').slice(-2))}
              aria-label="Hour"
            />
            <span className="dtp-time-sep">:</span>
            <input
              type="text"
              inputMode="numeric"
              className="dtp-time-input"
              value={pad2(selectedTime?.m ?? 0)}
              onChange={(e) => setTime('m', e.target.value.replace(/\D/g, '').slice(-2))}
              aria-label="Minute"
            />
          </div>
          <footer className="dtp-pop-foot">
            <button type="button" className="dtp-foot-btn" onClick={() => onChange('')}>Clear</button>
            <button
              type="button"
              className="dtp-foot-btn"
              onClick={() => {
                const now = new Date();
                commit(now, { h: now.getHours(), m: now.getMinutes() });
                setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1));
              }}
            >
              Now
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
