// Password input with show/hide toggle.
//
// Drop-in replacement for `<input type="password" ... />` — keeps the
// same controlled-input API (value + onChange) so existing forms just
// swap the element name. The eye toggle sits inside the input on the
// right, never overlapping caret or selection because we pad-right by
// the icon's width.
//
// Why not a separate library: the project doesn't depend on any UI
// kit (Mantine / Radix / etc.). A 40-line component matches the rest
// of the styling vocabulary (Tabler icons + inline styles) and keeps
// the bundle small.
//
// Accessibility:
//   • Toggle is a real <button type="button"> so screen readers see
//     it as an interactive control with `aria-label` and `aria-pressed`.
//   • Tabbing into the field skips the toggle (tabIndex={-1}) — the
//     password field is the primary element, the toggle is a side
//     control. Click / Space / Enter still activate it.
//   • The toggle does NOT echo the password value via aria-live —
//     showing plaintext is purely a visual affordance.

import React, { useState } from 'react';
import { Ti } from './shell.jsx';

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  placeholder,
  autoFocus,
  disabled,
  className,
  style,
  ...rest
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <input
        {...rest}
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        style={{
          ...style,
          width: '100%',
          // Reserve space for the toggle so the password text doesn't
          // run under the eye icon.
          paddingRight: 32,
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? 'Hide characters' : 'Show characters'}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          padding: 4,
          margin: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: 'var(--color-text-tertiary)',
          lineHeight: 0,
          opacity: disabled ? 0.4 : 1,
        }}
        title={visible ? 'Hide characters' : 'Show characters'}
      >
        <Ti name={visible ? 'eye-off' : 'eye'} size={16} />
      </button>
    </span>
  );
}

export default PasswordInput;
