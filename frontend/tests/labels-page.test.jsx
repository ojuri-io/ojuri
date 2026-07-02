import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ingestLabels = vi.fn();
vi.mock('../src/api/client.js', () => ({
  ingestLabels: (...args) => ingestLabels(...args),
}));

import Labels, { parseLabelLines } from '../src/pages/labels.jsx';

const adminUser = { permissions: ['*'] };

describe('parseLabelLines', () => {
  it('applies the default verdict to bare ids', () => {
    const { labels, errors } = parseLabelLines('tx-1\ntx-2', true);
    expect(errors).toEqual([]);
    expect(labels).toEqual([
      { transaction_id: 'tx-1', is_fraud: true },
      { transaction_id: 'tx-2', is_fraud: true },
    ]);
  });

  it('honors per-line verdicts in several spellings', () => {
    const { labels, errors } = parseLabelLines('tx-1,legit\ntx-2,fraud\ntx-3,false', true);
    expect(errors).toEqual([]);
    expect(labels.map((l) => l.is_fraud)).toEqual([false, true, false]);
  });

  it('collapses duplicate ids last-wins', () => {
    const { labels } = parseLabelLines('tx-1,fraud\ntx-1,legit', true);
    expect(labels).toEqual([{ transaction_id: 'tx-1', is_fraud: false }]);
  });

  it('reports malformed lines with line numbers', () => {
    const { labels, errors } = parseLabelLines('tx-1\ntx-2,maybe\na,b,c', true);
    expect(labels).toHaveLength(1);
    expect(errors[0]).toMatch(/line 2/);
    expect(errors[1]).toMatch(/line 3/);
  });

  it('ignores blank lines and whitespace', () => {
    const { labels, errors } = parseLabelLines('\n  tx-1 , legit \n\n', true);
    expect(errors).toEqual([]);
    expect(labels).toEqual([{ transaction_id: 'tx-1', is_fraud: false }]);
  });
});

describe('Labels page', () => {
  it('submits parsed labels with the selected source and shows the split', async () => {
    ingestLabels.mockResolvedValueOnce({ received: 2, applied: 1, unmatched: ['tx-2'] });

    render(<Labels toast={() => {}} user={adminUser} />);

    fireEvent.change(screen.getByPlaceholderText(/tx-2026-0001/), {
      target: { value: 'tx-1\ntx-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply 2 labels/ }));

    await waitFor(() => expect(ingestLabels).toHaveBeenCalledTimes(1));
    expect(ingestLabels).toHaveBeenCalledWith([
      { transaction_id: 'tx-1', is_fraud: true, source: 'chargeback' },
      { transaction_id: 'tx-2', is_fraud: true, source: 'chargeback' },
    ]);

    await screen.findByText(/1 of 2 applied/);
    expect(screen.getByText(/1 unmatched/)).toBeTruthy();
  });

  it('disables submit without labels:write', () => {
    render(<Labels toast={() => {}} user={{ permissions: ['audit:read'] }} />);

    fireEvent.change(screen.getByPlaceholderText(/tx-2026-0001/), {
      target: { value: 'tx-1' },
    });
    expect(screen.getByRole('button', { name: /Apply/ }).disabled).toBe(true);
  });
});
