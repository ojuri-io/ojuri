// Error boundary for the authenticated page area.
//
// React unmounts the entire tree above the throwing component when no
// boundary is present — that's the "blank dashboard" symptom. This
// boundary catches the throw, renders a friendly fallback, and lets
// the user navigate to a different page without reloading.
//
// Reset is keyed on `resetKey` so the parent (App) can recover the
// boundary by changing the current route — clicking a sidebar item
// changes the hash, which changes `resetKey`, which remounts the
// children. Without the key, the boundary stays in error state for
// the rest of the session.

import React from 'react';
import { Ti } from './shell.jsx';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    // Surface to the console; the production dashboard has no error
    // reporting backend wired yet. Keep this lightweight so a noisy
    // page doesn't spam logs.
    if (typeof console !== 'undefined') {
      console.error('[sentinel] page crashed:', err, info?.componentStack);
    }
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) {
      this.setState({ err: null });
    }
  }

  render() {
    if (!this.state.err) return this.props.children;
    const msg = String(this.state.err?.message || this.state.err);
    return (
      <div className="panel" style={{ padding: 36, textAlign: 'center' }}>
        <Ti name="alert-triangle" size={28} style={{ color: 'var(--color-text-danger)' }} />
        <h3 style={{ margin: '8px 0 4px', fontSize: 15, fontWeight: 500 }}>
          This page hit an error
        </h3>
        <p
          style={{
            margin: '0 0 12px',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            wordBreak: 'break-word',
          }}
        >
          {msg}
        </p>
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
          }}
        >
          Try navigating to another page from the sidebar, or reload to retry.
        </p>
        <button onClick={() => this.setState({ err: null })}>
          <Ti name="refresh" size={14} />
          Retry
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
