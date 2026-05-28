import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PasswordInput } from '../src/components/password-input.jsx';

describe('PasswordInput', () => {
  it('renders masked by default', () => {
    const { container } = render(<PasswordInput value="secret" onChange={() => {}} />);
    const input = container.querySelector('input');
    expect(input.type).toBe('password');
    expect(screen.getByRole('button', { name: /show characters/i })).toBeInTheDocument();
  });

  it('toggles to plaintext on click', () => {
    const { container } = render(<PasswordInput value="secret" onChange={() => {}} />);
    const input = container.querySelector('input');
    fireEvent.click(screen.getByRole('button', { name: /show characters/i }));
    expect(input.type).toBe('text');
    // After toggle the button now offers to hide.
    expect(screen.getByRole('button', { name: /hide characters/i })).toBeInTheDocument();
  });

  it('toggles back to masked on second click', () => {
    const { container } = render(<PasswordInput value="secret" onChange={() => {}} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(container.querySelector('input').type).toBe('password');
  });

  it('forwards onChange events to the parent', () => {
    // Controlled-input pattern: the parent owns state. We assert the
    // change handler fires; the value round-trips via the parent's
    // setState, which is exactly how the real login form uses this.
    const ParentHarness = () => {
      const [v, setV] = React.useState('');
      return (
        <>
          <PasswordInput value={v} onChange={(e) => setV(e.target.value)} />
          <span data-testid="echo">{v}</span>
        </>
      );
    };
    const { container } = render(<ParentHarness />);
    fireEvent.change(container.querySelector('input'), { target: { value: 'hunter2' } });
    expect(screen.getByTestId('echo').textContent).toBe('hunter2');
  });

  it('skips toggle in tab order (tabIndex=-1)', () => {
    render(<PasswordInput value="" onChange={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1');
  });

  it('disables the toggle when the input is disabled', () => {
    render(<PasswordInput value="x" onChange={() => {}} disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  // Alignment regression guard. The eye toggle is positioned with the
  // robust "stretch + flex-center" pattern: top:0 / bottom:0 on an
  // absolutely-positioned button, with flex centering the SVG inside.
  // The previous top:50% + translateY(-50%) approach drifted on
  // subpixel-rounded input heights, which is what the user kept
  // catching on the login screen. If a future edit reverts to the
  // translateY trick or drops the right-padding allowance, this test
  // catches it before the next screenshot does.
  it('keeps the toggle centered with the stretch+flex layout', () => {
    const { container } = render(<PasswordInput value="" onChange={() => {}} />);
    const input = container.querySelector('input');
    const btn = container.querySelector('button');
    // Input reserves enough right-padding for the 28px button + 8px
    // inset so the typed value can't run under the eye glyph.
    expect(input.style.paddingRight).toBe('36px');
    // Button stretches to the input height (no transform tricks).
    expect(btn.style.top).toBe('0px');
    expect(btn.style.bottom).toBe('0px');
    expect(btn.style.right).toBe('6px');
    expect(btn.style.alignItems).toBe('center');
    expect(btn.style.justifyContent).toBe('center');
  });
});
