import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Topbar, computeNotifications } from '../src/components/shell.jsx';

const user = {
  username: 'admin',
  fullName: 'Default Admin',
  roles: [{ id: 'r1', name: 'SUPER_ADMIN' }],
};

describe('Topbar', () => {
  it('renders the date label', () => {
    render(<Topbar dateLabel="Today · Wed, May 27" notifications={[]} user={user} />);
    expect(screen.getByText('Today · Wed, May 27')).toBeInTheDocument();
  });

  it('shows the unread badge when notifications are present', () => {
    const items = [
      { icon: 'flag', title: 'one', sub: '', when: 'Now' },
      { icon: 'flag', title: 'two', sub: '', when: 'Now' },
    ];
    render(<Topbar notifications={items} user={user} />);
    const bell = screen.getByRole('button', { name: /notifications \(2 unread\)/i });
    expect(bell).toBeInTheDocument();
    // The badge renders the count.
    expect(bell.textContent).toContain('2');
  });

  it('hides the badge when there are no notifications', () => {
    render(<Topbar notifications={[]} user={user} />);
    const bell = screen.getByRole('button', { name: /^notifications$/i });
    expect(bell.textContent).not.toMatch(/\d/);
  });

  it('opens the notifications popover and lists items', () => {
    const onClick = vi.fn();
    const items = [
      { icon: 'flag', title: '3 declined transactions pending review', sub: 'Open queue', when: 'Now', onClick },
    ];
    render(<Topbar notifications={items} user={user} />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(screen.getByText('3 declined transactions pending review')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 declined transactions pending review'));
    expect(onClick).toHaveBeenCalled();
  });

  it('opens the user menu and fires onLogout when Sign out is clicked', () => {
    const onLogout = vi.fn();
    render(<Topbar notifications={[]} user={user} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('renders the user name and role in the menu', () => {
    render(<Topbar notifications={[]} user={user} onLogout={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
    // Name appears in both the topbar button and the menu head; both should resolve.
    expect(screen.getAllByText('Default Admin').length).toBeGreaterThan(0);
    expect(screen.getByText('SUPER_ADMIN')).toBeInTheDocument();
  });
});

describe('computeNotifications', () => {
  it('returns an empty list when nothing needs attention', () => {
    expect(
      computeNotifications({ queueCount: 0, reports: [], models: [], webhooks: [], nav: () => {} }),
    ).toEqual([]);
  });

  it('includes a review-queue item when queueCount > 0', () => {
    const items = computeNotifications({
      queueCount: 5,
      reports: [],
      models: [],
      webhooks: [],
      nav: () => {},
    });
    expect(items[0].title).toMatch(/5 declined transactions pending review/);
    expect(items[0].icon).toBe('flag');
  });

  it('falls back to queue.length when queueCount is missing', () => {
    const items = computeNotifications({
      queue: [{}, {}, {}],
      reports: [],
      models: [],
      webhooks: [],
      nav: () => {},
    });
    expect(items[0].title).toMatch(/3 declined/);
  });

  it('flags a SHADOW model ready to activate', () => {
    const items = computeNotifications({
      queueCount: 0,
      reports: [],
      models: [{ version: 'v2.0', status: 'SHADOW' }],
      webhooks: [],
      nav: () => {},
    });
    expect(items.some((i) => /v2\.0 ready to activate/.test(i.title))).toBe(true);
  });

  it('flags failing webhooks', () => {
    const items = computeNotifications({
      queueCount: 0,
      reports: [],
      models: [],
      webhooks: [{ status: 'failing' }, { status: 'ok' }, { status: 'failing' }],
      nav: () => {},
    });
    expect(items.some((i) => /2 webhook deliveries failing/.test(i.title))).toBe(true);
  });

  it('invokes nav with the right route when a notification onClick fires', () => {
    const nav = vi.fn();
    const items = computeNotifications({
      queueCount: 1,
      reports: [],
      models: [],
      webhooks: [],
      nav,
    });
    items[0].onClick();
    expect(nav).toHaveBeenCalledWith('queue');
  });
});
