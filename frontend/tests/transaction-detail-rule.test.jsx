import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const ruleExpression = {
  and: [
    { '>=': [{ var: 'amount' }, 100000] },
    { '==': [{ var: 'ip_country' }, 'NL'] },
  ],
};

vi.mock('../src/api/client.js', () => ({
  getDecision: vi.fn(() =>
    Promise.resolve({
      id: 'audit-1',
      transactionId: 'TXN-RULE-TEST-1',
      senderId: 'sender-a',
      receiverId: 'receiver-b',
      amount: '250000',
      transactionType: 'TRANSFER',
      segment: 'p2p_transfer',
      championModelVersion: 'v1.1.0',
      championScore: 0.42,
      threshold: 0.65,
      mlDecision: 'ACCEPT',
      finalDecision: 'DECLINE',
      decisionSource: 'PRE_RULE',
      ruleId: 'rule-vpn-hi-amount',
      ruleName: 'High amount via VPN',
      ruleStage: 'PRE',
      ruleAction: 'DENY',
      ruleExpression,
      reasonCodes: [],
      latencyMs: 7,
      createdAt: '2026-05-31T10:00:00.000Z',
    }),
  ),
  overrideDecision: vi.fn(),
  requestReport: vi.fn(),
  postReportMessage: vi.fn(),
}));

import TransactionDetail from '../src/pages/transaction-detail.jsx';

const noop = () => {};

describe('TransactionDetail — rule snapshot panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      sessionStorage.clear();
    } catch {
      /* private window — ignore */
    }
  });

  afterEach(() => {
    location.hash = '';
  });

  it('renders rule name, stage, action, and expression from the audit row', async () => {
    render(
      <TransactionDetail
        toast={noop}
        user={{ username: 'analyst' }}
        nav={noop}
        txn="TXN-RULE-TEST-1"
        queue={[]}
        reports={[]}
        refreshQueueCount={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('rule-panel')).toBeInTheDocument();
    });

    expect(screen.getByTestId('rule-name')).toHaveTextContent('High amount via VPN');
    expect(screen.getByTestId('rule-stage')).toHaveTextContent('PRE');
    expect(screen.getByTestId('rule-action')).toHaveTextContent('DENY');

    fireEvent.click(screen.getByTestId('rule-panel-toggle'));

    const exprNode = await screen.findByTestId('rule-expression');
    expect(exprNode.textContent).toContain('"ip_country"');
    expect(exprNode.textContent).toContain('100000');
  });

  it('exposes an "Edit this rule" link that targets the rules editor route', async () => {
    render(
      <TransactionDetail
        toast={noop}
        user={{ username: 'analyst' }}
        nav={noop}
        txn="TXN-RULE-TEST-1"
        queue={[]}
        reports={[]}
        refreshQueueCount={noop}
      />,
    );

    const toggle = await screen.findByTestId('rule-panel-toggle');
    fireEvent.click(toggle);

    const link = await screen.findByTestId('rule-edit-link');
    expect(link.getAttribute('href')).toBe('#rules');
    fireEvent.click(link);
    expect(sessionStorage.getItem('sentinel.rules.focusId')).toBe('rule-vpn-hi-amount');
  });
});
