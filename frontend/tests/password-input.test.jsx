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
});
