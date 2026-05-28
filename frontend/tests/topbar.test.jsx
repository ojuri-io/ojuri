import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Topbar, computeNotifications, unreadCount } from '../src/components/shell.jsx';

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

  it('attaches an anchor timestamp derived from the freshest source row', () => {
    const t1 = '2026-05-20T09:00:00Z';
    const t2 = '2026-05-21T11:30:00Z';
    const items = computeNotifications({
      queueCount: 2,
      queue: [{ createdAt: t1 }, { createdAt: t2 }],
      reports: [{ createdAt: t1, verdict: 'FRAUD_CONFIRMED' }],
      models: [{ version: 'v3', status: 'SHADOW', createdAt: t2 }],
      webhooks: [],
      nav: () => {},
    });
    const queueItem = items.find((i) => i.icon === 'flag');
    const shadowItem = items.find((i) => i.icon === 'cpu');
    expect(queueItem.anchor).toBe(new Date(t2).toISOString()); // picks the max
    expect(shadowItem.anchor).toBe(new Date(t2).toISOString());
  });
});

describe('unreadCount', () => {
  it('returns 0 for an empty list regardless of lastSeenAt', () => {
    expect(unreadCount([], null)).toBe(0);
    expect(unreadCount([], '2026-05-20T00:00:00Z')).toBe(0);
  });

  it('treats null lastSeenAt as "everything unread"', () => {
    const items = [{ anchor: '2026-05-01T00:00:00Z' }, { anchor: '2026-05-02T00:00:00Z' }];
    expect(unreadCount(items, null)).toBe(2);
  });

  it('counts items whose anchor is strictly newer than lastSeenAt', () => {
    const seen = '2026-05-15T00:00:00Z';
    const items = [
      { anchor: '2026-05-14T00:00:00Z' }, // older — read
      { anchor: '2026-05-15T00:00:00Z' }, // same — read
      { anchor: '2026-05-16T00:00:00Z' }, // newer — unread
    ];
    expect(unreadCount(items, seen)).toBe(1);
  });

  it('counts null-anchor items as unread when the bell has never been opened', () => {
    const items = [
      { anchor: null },
      { anchor: undefined },
      { /* no anchor key */ },
    ];
    // No lastSeenAt → the early-return path; everything is unread.
    expect(unreadCount(items, null)).toBe(3);
  });

  it('treats null-anchor items as seen once lastSeenAt is set', () => {
    // The badge has to be able to drop to zero even when some
    // notification items lack a concrete anchor — common when the
    // dashboard `queue` / `reports` props are empty because the
    // operator hasn't visited those pages yet. Without this,
    // anchorless items would keep the badge stuck forever.
    const items = [
      { anchor: null },
      { anchor: undefined },
      { /* no anchor key */ },
    ];
    expect(unreadCount(items, '2026-05-15T00:00:00Z')).toBe(0);
  });

  it('treats malformed lastSeenAt as "everything unread"', () => {
    const items = [{ anchor: '2026-05-15T00:00:00Z' }];
    expect(unreadCount(items, 'not-a-date')).toBe(1);
  });
});
