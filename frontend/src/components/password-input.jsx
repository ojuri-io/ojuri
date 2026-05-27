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

import { useState } from 'react';
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
    <span
      style={{
        // display: block (not inline-block) so the wrapper's height
        // is exactly the input's height. Inline-block leaves a few
        // px of baseline descender space below the input, which made
        // the absolutely-positioned toggle sit below the visual
        // mid-line even with top:50% + translateY(-50%).
        position: 'relative',
        display: 'block',
        width: '100%',
      }}
    >
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
          // Flex centering so the SVG sits on the button's own box
          // axis — the global Ti wrapper sets
          // `vertical-align: text-bottom` for inline contexts, which
          // would otherwise push the icon below the input's mid-line.
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: 'var(--ink-muted)',
          opacity: disabled ? 0.4 : 1,
        }}
        title={visible ? 'Hide characters' : 'Show characters'}
      >
        <Ti
          name={visible ? 'eye-off' : 'eye'}
          size={16}
          style={{ verticalAlign: 'middle' }}
        />
      </button>
    </span>
  );
}

export default PasswordInput;
