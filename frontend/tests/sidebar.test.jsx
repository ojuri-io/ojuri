import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../src/components/shell.jsx';

describe('Sidebar', () => {
  it('renders every nav group label', () => {
    render(<Sidebar active="dash" onNav={() => {}} queueCount={3} />);
    for (const label of ['DETECTION', 'INSIGHTS', 'CONFIG']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('marks the active item with the active class', () => {
    const { container } = render(
      <Sidebar active="rules" onNav={() => {}} queueCount={0} />,
    );
    const active = container.querySelector('[data-nav-id="rules"]');
    expect(active?.className).toContain('active');
  });

  it('switches the queue badge to danger once over six pending items', () => {
    const { container } = render(
      <Sidebar active="dash" onNav={() => {}} queueCount={9} />,
    );
    const queue = container.querySelector('[data-nav-id="queue"]');
    const badge = queue?.querySelector('.nav-count');
    expect(badge?.className).toContain('danger');
    expect(badge?.textContent).toBe('9');
  });

  it('invokes onNav with the nav id when an item is clicked', () => {
    const onNav = vi.fn();
    render(<Sidebar active="dash" onNav={onNav} queueCount={2} />);
    fireEvent.click(screen.getByText('Live decisions'));
    expect(onNav).toHaveBeenCalledWith('live');
  });

  // Identity + sign-out moved to the global Topbar. See topbar.test.jsx
  // for the user-menu coverage.
});
