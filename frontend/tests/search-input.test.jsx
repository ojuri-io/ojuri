// Behavioural tests for the search-on-Enter helpers used across the
// fraud-ops dashboard. Verifies the contract the rest of the app relies
// on: typing edits *only* a local draft, and the parent receives the
// committed value only on Enter or onBlur-after-change.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchInput, DateRangeFilter } from '../src/components/search-input.jsx';

describe('SearchInput', () => {
  it('does not commit while the user is typing', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="" onCommit={onCommit} placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.change(input, { target: { value: 'hello w' } });
    fireEvent.change(input, { target: { value: 'hello wo' } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits on Enter with the current draft', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="" onCommit={onCommit} placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('abc');
  });

  it('commits on blur when the draft differs from the committed value', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="" onCommit={onCommit} placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('edited');
  });

  it('does not commit on blur when the draft equals the committed value', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="same" onCommit={onCommit} placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    // Type the same string out, then re-blur.
    fireEvent.change(input, { target: { value: 'same' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Escape reverts the draft to the committed value without commit', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="committed" onCommit={onCommit} placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('committed');
  });

  it('clear button commits empty string immediately', () => {
    const onCommit = vi.fn();
    render(<SearchInput value="something" onCommit={onCommit} placeholder="Search" />);
    const btn = screen.getByLabelText('Clear search');
    fireEvent.click(btn);
    expect(onCommit).toHaveBeenCalledWith('');
  });
});

describe('DateRangeFilter', () => {
  it('does not call onApply while the user edits the date inputs', () => {
    const onApply = vi.fn();
    const { container } = render(
      <DateRangeFilter from="" to="" onApply={onApply} />,
    );
    const inputs = container.querySelectorAll('input[type="datetime-local"]');
    expect(inputs.length).toBe(2);
    fireEvent.change(inputs[0], { target: { value: '2026-05-01T00:00' } });
    fireEvent.change(inputs[1], { target: { value: '2026-05-13T00:00' } });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('commits both bounds when the Apply button is clicked', () => {
    const onApply = vi.fn();
    const { container } = render(
      <DateRangeFilter from="" to="" onApply={onApply} />,
    );
    const inputs = container.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0], { target: { value: '2026-05-01T00:00' } });
    fireEvent.change(inputs[1], { target: { value: '2026-05-13T00:00' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledWith({
      from: '2026-05-01T00:00',
      to: '2026-05-13T00:00',
    });
  });

  it('Enter on a date input commits the current draft', () => {
    const onApply = vi.fn();
    const { container } = render(
      <DateRangeFilter from="" to="" onApply={onApply} />,
    );
    const inputs = container.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0], { target: { value: '2026-05-05T08:00' } });
    fireEvent.keyDown(inputs[0], { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith({ from: '2026-05-05T08:00', to: '' });
  });
});
