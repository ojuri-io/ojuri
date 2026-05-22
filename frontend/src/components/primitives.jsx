// Universal layout primitives — Panel, Section, Stat, EmptyState.
//
// These are the building blocks called out in the Ojuri design-system
// spec §3. Every module page that needs a card, a section header, a
// KPI display, or an empty-state placeholder should reach for these
// rather than rolling its own. Drop any pre-existing one-off
// equivalents from the modules as you migrate them.
//
// All four lean on the existing CSS tokens — they don't ship their own
// colors, fonts, or radii beyond the inline-style declarations needed
// to keep them self-contained without adding more class names.

import React from 'react';
import { Ti } from './shell.jsx';

// ──────── Panel ────────
// Standard card. Cream surface, 1px stone-300 border, 4px corners, no
// shadow. Default padding 16px; override with the `pad` prop. Elevation
// comes from borders, not shadows.
export function Panel({ children, className, pad = 'var(--space-4)', style, ...rest }) {
  return (
    <div
      className={['panel', className].filter(Boolean).join(' ')}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        padding: pad,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ──────── Section ────────
// Header block used at the top of every module page: optional mono
// eyebrow, serif title, optional action buttons on the right. Pass
// `children` for the page body that sits below.
export function Section({ eyebrow, title, sub, actions, children, style }) {
  return (
    <section style={style}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div>
          {eyebrow && (
            <p
              style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--ink-faint)',
                lineHeight: 1,
              }}
            >
              {eyebrow}
            </p>
          )}
          <h2
            style={{
              margin: eyebrow ? 'var(--space-2) 0 0' : 0,
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: 22,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              color: 'var(--ink)',
            }}
          >
            {title}
          </h2>
          {sub && (
            <p
              style={{
                margin: 'var(--space-2) 0 0',
                fontFamily: 'var(--font-sans)',
                fontSize: 13.5,
                color: 'var(--ink-muted)',
                lineHeight: 1.45,
                maxWidth: 'var(--max-width-prose)',
              }}
            >
              {sub}
            </p>
          )}
        </div>
        {actions && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {actions}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

// ──────── Stat ────────
// KPI display. Mono eyebrow label, large serif value, optional mono
// delta below ("+12.4%" / "-3.1%"). Numbers ≥ 4 digits get tabular-nums
// so the digits don't shift width between renders.
export function Stat({ label, value, delta, deltaTone, sub, style }) {
  const tone =
    deltaTone === 'up' ? 'var(--chart-allow)' :
    deltaTone === 'down' ? 'var(--chart-decline)' :
    'var(--ink-muted)';
  const valStr = value == null ? '—' : String(value);
  const tabular = /\d{4,}/.test(valStr);
  return (
    <div style={style}>
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--ink-faint)',
          lineHeight: 1,
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: 'var(--space-2) 0 0',
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: 28,
          letterSpacing: '-0.01em',
          lineHeight: 1.05,
          color: 'var(--ink)',
          fontVariantNumeric: tabular ? 'tabular-nums' : 'normal',
        }}
      >
        {valStr}
      </p>
      {(delta || sub) && (
        <p
          style={{
            margin: 'var(--space-2) 0 0',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: delta ? tone : 'var(--ink-muted)',
            lineHeight: 1,
          }}
        >
          {delta || sub}
        </p>
      )}
    </div>
  );
}

// ──────── EmptyState ────────
// Placeholder for empty tables / lists. Thin stone-300 border, ink
// title, muted body. Optional Lucide icon name (passed through to
// `<Ti />`) and a single action child (button/link).
export function EmptyState({ icon, title, body, action, style }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 'var(--space-10) var(--space-4)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        background: 'var(--surface)',
        ...style,
      }}
    >
      {icon && (
        <Ti
          name={icon}
          size={20}
          style={{ color: 'var(--ink-faint)', marginBottom: 'var(--space-3)' }}
        />
      )}
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          fontSize: 16,
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
        }}
      >
        {title}
      </p>
      {body && (
        <p
          style={{
            margin: 'var(--space-2) 0 0',
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            color: 'var(--ink-muted)',
            lineHeight: 1.5,
            maxWidth: 'var(--max-width-prose)',
          }}
        >
          {body}
        </p>
      )}
      {action && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  );
}
