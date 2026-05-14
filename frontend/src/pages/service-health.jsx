// System health — service cards + infrastructure
//
// Reads `/v1/health/services` (RDA fanout to each service's /readyz) and
// `/v1/health/infra` (Postgres / Redis / Kafka pings). The incidents
// panel was removed in this revision — there's no underlying incidents
// log feature yet, so showing one would have been theatre.

import React, { useState, useEffect, useCallback } from 'react';
import { Ti, PageHead } from '../components/shell.jsx';
import { getServiceHealth, getInfraHealth } from '../api/client.js';

const REFRESH_MS = 5000;

function ServiceHealth({ toast }) {
  const [services, setServices] = useState(null);
  const [infra, setInfra] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const refresh = useCallback(async (loud = false) => {
    try {
      const [s, i] = await Promise.all([getServiceHealth(), getInfraHealth()]);
      setServices(Array.isArray(s) ? s : []);
      setInfra(Array.isArray(i) ? i : []);
      setRefreshedAt(Date.now());
      if (loud) toast('Refreshed');
    } catch {
      if (loud) toast('Refresh failed', 'danger');
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const upCount = (services || []).filter((s) => s.status === 'UP').length;
  const degradedCount = (services || []).filter((s) => s.status === 'DEGRADED').length;
  const downCount = (services || []).filter((s) => s.status === 'DOWN').length;
  const refreshLabel =
    refreshedAt == null ? '—' : `${Math.max(0, Math.round((Date.now() - refreshedAt) / 1000))}s ago`;

  return (
    <>
      <PageHead
        crumbs={['Dashboard', 'Insights']}
        title="System health"
        sub={
          services == null ? (
            'Loading…'
          ) : (
            <>
              {upCount} healthy{degradedCount > 0 ? `, ${degradedCount} degraded` : ''}
              {downCount > 0 ? `, ${downCount} down` : ''} · refreshed <span className="mono">{refreshLabel}</span>
            </>
          )
        }
      >
        <button onClick={() => refresh(true)}><Ti name="refresh" size={14} />Refresh</button>
      </PageHead>

      {/* Services 2x2 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        {(services || []).map((s) => (
          <ServiceCard key={s.name} {...s} />
        ))}
        {services != null && services.length === 0 && (
          <div className="panel" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 12, gridColumn: '1 / -1' }}>
            No services configured. Set <code className="mono">PAA_HEALTH_URL</code> / <code className="mono">FIA_HEALTH_URL</code> in the RDA env.
          </div>
        )}
      </div>

      {/* Infra */}
      <section className="panel" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 500 }}>Infrastructure</h2>
        {infra == null ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {infra.map((card) => (
              <InfraCard key={card.name} {...card} />
            ))}
          </div>
        )}
      </section>

      {/*
        Incidents panel removed. An incidents history would need its own
        backing table (and writer) — neither exists yet. Until that
        feature is built, showing a static "Recent incidents" list would
        be misleading.
      */}
    </>
  );
}

function ServiceCard({ name, description, status, kvs = [], url, latencyMs, when }) {
  const dotColor =
    status === 'UP'
      ? 'var(--color-text-success)'
      : status === 'DEGRADED'
      ? 'var(--color-text-warning)'
      : status === 'DOWN'
      ? 'var(--color-text-danger)'
      : 'var(--color-text-tertiary)';
  const pillCls = status === 'UP' ? 'success' : status === 'DEGRADED' ? 'warn' : status === 'DOWN' ? 'danger' : '';
  const borderColor =
    status === 'DEGRADED' ? 'var(--color-border-warning)' : status === 'DOWN' ? 'var(--color-border-danger)' : 'var(--color-border-tertiary)';
  return (
    <article
      style={{
        background: 'var(--color-background-primary)',
        border: `0.5px solid ${borderColor}`,
        borderRadius: 'var(--border-radius-lg)',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor }} />
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>{name}</h3>
          </div>
          <p style={{ margin: '3px 0 0', fontSize: 10, color: 'var(--color-text-secondary)' }}>{description || ''}</p>
        </div>
        <span className={'pill ' + pillCls} style={{ fontSize: 9, padding: '2px 7px' }}>{status}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        {kvs.map((kv, i) => (
          <div key={i}>
            <p className="label-up" style={{ margin: 0, fontSize: 9 }}>{kv.k}</p>
            <p
              className="mono truncate"
              style={{
                margin: '2px 0 0',
                fontSize: 13,
                fontWeight: 500,
                color:
                  kv.tone === 'success'
                    ? 'var(--color-text-success)'
                    : kv.tone === 'warning'
                    ? 'var(--color-text-warning)'
                    : kv.tone === 'danger'
                    ? 'var(--color-text-danger)'
                    : 'inherit',
              }}
            >
              {kv.v}
            </p>
          </div>
        ))}
      </div>
      <div
        style={{
          paddingTop: 10,
          borderTop: '0.5px solid var(--color-border-tertiary)',
          fontSize: 10,
          color: 'var(--color-text-secondary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <code className="mono truncate" style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
          {url || 'not configured'}
        </code>
        <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {latencyMs == null ? '—' : `${latencyMs}ms`}
        </span>
      </div>
    </article>
  );
}

function InfraCard({ name, status, kvs = [] }) {
  const pillCls = status === 'UP' ? 'success' : status === 'DEGRADED' ? 'warn' : status === 'DOWN' ? 'danger' : '';
  const icon = name === 'Postgres' ? 'database' : name === 'Redis' ? 'server-bolt' : name === 'Kafka' ? 'route' : 'server';
  return (
    <div style={{ padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Ti name={icon} size={13} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>{name}</span>
        <span className={'pill ' + pillCls} style={{ marginLeft: 'auto', fontSize: 9, padding: '1px 5px' }}>{status}</span>
      </div>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10 }}>
        {kvs.map((kv, i) => (
          <div key={i}>
            <span style={{ color: 'var(--color-text-tertiary)' }}>{kv.k}</span>
            <span
              className="truncate"
              style={{
                marginLeft: 4,
                fontWeight: 500,
                color:
                  kv.tone === 'success'
                    ? 'var(--color-text-success)'
                    : kv.tone === 'warning'
                    ? 'var(--color-text-warning)'
                    : kv.tone === 'danger'
                    ? 'var(--color-text-danger)'
                    : 'inherit',
              }}
            >
              {kv.v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ServiceHealth;
