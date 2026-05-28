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
        // Wrapper height tracks the input exactly. We use `display:
        // block` (not inline-block) to avoid baseline-descender space
        // below the input; and the toggle inside uses top:0/bottom:0
        // to stretch to the full input height, which centers the
        // icon deterministically via flex regardless of input padding
        // or computed line-height. The older top:50% + translateY
        // approach drifted on subpixel-rounded heights — particularly
        // visible at the login screen's 13px font + 6px vertical
        // padding (input height ends at an odd pixel count).
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
          // run under the eye icon. 36px = 28 (button) + 8 (right
          // inset of the button from the input border).
          paddingRight: 36,
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
          // Button stretches to the input's full height via top:0 /
          // bottom:0, then centers the SVG with flex. This is the
          // canonical "icon-inside-input" pattern — robust against
          // input padding, border, line-height, and zoom changes.
          position: 'absolute',
          right: 6,
          top: 0,
          bottom: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
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
          // `display: block` on the SVG prevents the icon's
          // inline-baseline from picking up the page line-height,
          // which previously pushed the glyph a fractional pixel
          // below the flex centerline.
          style={{ display: 'block' }}
        />
      </button>
    </span>
  );
}

export default PasswordInput;
