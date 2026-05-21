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
    const triggers = container.querySelectorAll('.dtp-trigger');
    expect(triggers.length).toBe(2);
    fireEvent.click(triggers[0]);
    fireEvent.click(screen.getByText('Now'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('commits both bounds when the Apply button is clicked', () => {
    const onApply = vi.fn();
    const { container } = render(
      <DateRangeFilter from="" to="" onApply={onApply} />,
    );
    const triggers = container.querySelectorAll('.dtp-trigger');
    fireEvent.click(triggers[0]);
    fireEvent.click(screen.getByText('Now'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(triggers[1]);
    fireEvent.click(screen.getByText('Now'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const arg = onApply.mock.calls[0][0];
    expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('Clear in the picker empties the bound without auto-applying', () => {
    const onApply = vi.fn();
    const { container } = render(
      <DateRangeFilter from="2026-05-05T08:00" to="" onApply={onApply} />,
    );
    const triggers = container.querySelectorAll('.dtp-trigger');
    fireEvent.click(triggers[0]);
    fireEvent.click(screen.getByText('Clear'));
    expect(onApply).not.toHaveBeenCalled();
  });
});
