// Page 8 — Integrations (API keys + webhooks)
//
// "Recent deliveries" hydrates from `GET /v1/admin/webhook-deliveries` and
// falls back to the seeded `deliveries` prop when the API is unreachable.

import React, { useState, useEffect } from 'react';
import { Ti, PageHead, Modal, permLock } from '../components/shell.jsx';
import {
  issueApiKey as apiIssueApiKey,
  revokeApiKey as apiRevokeApiKey,
  subscribeWebhook as apiSubscribeWebhook,
  deleteWebhook as apiDeleteWebhook,
  listWebhookDeliveries,
} from '../api/client.js';

function Integrations({ toast, apiKeys, setApiKeys, webhooks, setWebhooks, deliveries: deliveriesProp, user }) {
  // Live recent-deliveries list — falls back to the prop mock when the API
  // is unreachable so the page keeps demoing.
  // `expanded` flips the panel from the "preview" (12 newest, no
  // filter) to "view all" mode (200 rows, status filter chips). The
  // refetch on either bump goes through the same effect.
  const [liveDeliveries, setLiveDeliveries] = useState(null);
  const [deliveriesExpanded, setDeliveriesExpanded] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState('ALL');
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDeliveriesLoading(true);
    const filters = {
      limit: deliveriesExpanded ? 200 : 12,
      status: deliveryStatus === 'ALL' ? undefined : deliveryStatus,
    };
    listWebhookDeliveries(filters)
      .then((rows) => {
        if (cancelled) return;
        setLiveDeliveries(Array.isArray(rows) ? rows.map(normaliseDelivery) : null);
      })
      .catch(() => {
        if (cancelled) return;
        setLiveDeliveries(null);
      })
      .finally(() => {
        if (!cancelled) setDeliveriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deliveriesExpanded, deliveryStatus]);
  const deliveries = liveDeliveries || deliveriesProp;
  const [revealed, setRevealed] = useState(null); // { name, fullKey, copied }
  const [issueOpen, setIssueOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);

  const onIssue = async (form) => {
    let fullKey;
    let prefix;
    let id;
    try {
      const res = await apiIssueApiKey({
        name: form.name,
        scope: form.scope,
        rateLimit: form.rateLimit,
        expiresAt: form.expires === 'no expiry' ? undefined : form.expires,
      });
      fullKey = res.token || res.apiKey || res.key;
      prefix = res.prefix || (fullKey ? fullKey.slice(0, fullKey.lastIndexOf('_') + 1) : '');
      id = res.id;
    } catch {
      // Fallback so the dashboard demos when the backend is offline.
      id = 'key_' + Math.floor(Math.random() * 999) + 'H';
      prefix = 'fdk_' + Math.random().toString(16).slice(2, 14) + '_';
      fullKey =
        prefix +
        Math.random().toString(36).slice(2, 14).toUpperCase() +
        Math.random().toString(36).slice(2, 22);
    }
    const newKey = { id, name: form.name, prefix, scope: form.scope, rateLimit: form.rateLimit, lastUsed: 'never', expires: form.expires, status: 'active' };
    setApiKeys(k => [newKey, ...k]);
    setIssueOpen(false);
    setRevealed({ name: form.name, fullKey, copied: false });
  };

  const onSubscribe = async (form) => {
    let id;
    let secret;
    try {
      const res = await apiSubscribeWebhook({ url: form.url, events: form.events });
      id = res.id;
      secret = res.secret;
    } catch {
      id = 'wh_' + Math.floor(Math.random() * 99);
      secret = 'whsec_' + Math.random().toString(16).slice(2, 6) + '…';
    }
    setWebhooks(w => [...w, {
      id, url: form.url, events: form.events,
      successRate: 100, status: 'healthy',
      secret,
      lastDelivery: { code: null, when: 'no deliveries yet', tone: 'tertiary' },
      maxRetries: 6
    }]);
    setSubscribeOpen(false);
    toast(`Webhook subscribed · ${form.url}`, 'success');
  };

  const onRevoke = async (k) => {
    try {
      await apiRevokeApiKey(k.id);
    } catch {
      // Tolerate offline revocation so the UI keeps moving.
    }
    setApiKeys(ks => ks.map(x => x.id === k.id ? {...x, status:'revoked', lastUsed: 'just now', expires: 'revoked today'} : x));
    toast(`Revoked · ${k.name}`, 'danger');
  };

  const onRemoveWebhook = async (w) => {
    try {
      await apiDeleteWebhook(w.id);
    } catch {
      // Tolerate offline delete.
    }
    setWebhooks(ws => ws.filter(x => x.id !== w.id));
    toast(`Removed ${w.url}`, 'danger');
  };

  return (
    <>
      <PageHead crumbs={['Dashboard','Config']} title="Integrations" sub="API keys and webhook subscriptions for your prediction and audit endpoints"/>

      {/* ──── API keys ──── */}
      <section className="panel" style={{marginBottom:14, padding:'16px 18px'}}>
        <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8, marginBottom:12}}>
          <div>
            <h2 style={{margin:0, fontSize:15, fontWeight:500}}>API keys</h2>
            <p style={{margin:'2px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>Authenticate calls to <code className="mono">/v1/predict</code> and read-only audit endpoints</p>
          </div>
          <button className="info-bg" onClick={()=>setIssueOpen(true)} {...permLock(user, 'api_keys:issue')}><Ti name="plus" size={14}/>Issue new key</button>
        </div>

        {revealed && <RevealCallout reveal={revealed} onCopy={()=>{ navigator.clipboard?.writeText(revealed.fullKey); setRevealed(r => ({...r, copied: true})); toast('Key copied to clipboard', 'success'); }} onDismiss={()=>setRevealed(null)}/>}

        <div className="row-grid header" style={{gridTemplateColumns:'1.4fr 1.4fr 80px 90px 80px 28px'}}>
          <span>NAME</span><span>PREFIX</span><span>SCOPE</span><span>RATE/MIN</span><span>LAST USED</span><span></span>
        </div>
        {apiKeys.map(k => (
          <div key={k.id} className="row-grid" style={{gridTemplateColumns:'1.4fr 1.4fr 80px 90px 80px 28px', opacity: k.status === 'revoked' ? 0.55 : 1, padding:'var(--row-pad-y, 9px) 0'}}>
            <div style={{minWidth:0}}>
              <p style={{margin:0, fontSize:12, fontWeight:500, display:'flex', alignItems:'center', gap:6}} className="truncate">
                {k.name}
                {k.status === 'revoked' && <span style={{fontSize:9, color:'var(--color-text-danger)', fontWeight:500}}>REVOKED</span>}
              </p>
              <p style={{margin:'1px 0 0', fontSize:10, color:'var(--color-text-tertiary)'}}>{k.expires}</p>
            </div>
            <code className="mono truncate" style={{fontSize:10, color:'var(--color-text-secondary)'}}>{k.prefix}…</code>
            <span className="pill" style={{justifySelf:'start', padding:'2px 7px'}}>{k.scope}</span>
            <span style={{fontSize:12, fontWeight:500, color: k.status === 'revoked' ? 'var(--color-text-tertiary)' : 'inherit'}}>{k.rateLimit ? k.rateLimit.toLocaleString() : '—'}</span>
            <span style={{fontSize:11, color: k.status === 'revoked' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)'}}>{k.lastUsed}</span>
            <div style={{position:'relative'}}>
              <button className="ghost icon-only" onClick={()=>setOpenMenu(openMenu === k.id ? null : k.id)}>
                <Ti name="dots-vertical" size={12}/>
              </button>
              {openMenu === k.id && (
                <KeyMenu
                  key_={k}
                  onClose={()=>setOpenMenu(null)}
                  onRotate={()=>{ setOpenMenu(null); toast('Key rotation coming soon'); }}
                  onRevoke={()=>{ setOpenMenu(null); setConfirmRevoke(k); }}
                />
              )}
            </div>
          </div>
        ))}
      </section>

      {/* ──── Webhooks ──── */}
      <section className="panel" style={{padding:'16px 18px'}}>
        <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8, marginBottom:12}}>
          <div>
            <h2 style={{margin:0, fontSize:15, fontWeight:500}}>Webhook subscriptions</h2>
            <p style={{margin:'2px 0 0', fontSize:11, color:'var(--color-text-secondary)'}}>HMAC-signed POSTs · at-least-once delivery with exponential backoff</p>
          </div>
          <button onClick={()=>setSubscribeOpen(true)} {...permLock(user, 'webhooks:create')}><Ti name="plus" size={14}/>Subscribe</button>
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:8, marginBottom:14}}>
          {webhooks.map(w => <WebhookCard key={w.id} w={w} toast={toast} onRemove={()=>onRemoveWebhook(w)}/>)}
        </div>

        {/* Recent deliveries — collapses to "preview" (12 newest) or expands
            to "view all" (up to 200, status-filterable). Both modes hit
            GET /v1/admin/webhook-deliveries; the link just bumps the limit
            and reveals the status chip row. */}
        <div>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8}}>
            <h3 style={{margin:0, fontSize:12, fontWeight:500}}>
              {deliveriesExpanded ? 'All deliveries' : 'Recent deliveries'}
              {deliveriesLoading && <span style={{marginLeft:8, fontSize:10, color:'var(--color-text-tertiary)'}}>loading…</span>}
              {!deliveriesLoading && <span style={{marginLeft:8, fontSize:10, color:'var(--color-text-tertiary)'}}>· {deliveries.length} shown</span>}
            </h3>
            <button
              onClick={() => setDeliveriesExpanded((v) => !v)}
              style={{padding:'3px 8px', fontSize:11}}
              title={deliveriesExpanded ? 'Collapse back to the 12 newest' : 'Load up to 200 deliveries with filters'}
            >
              {deliveriesExpanded ? 'Collapse' : 'View all'}
              <Ti name={deliveriesExpanded ? 'chevron-up' : 'chevron-right'} size={12} style={{marginLeft:2, verticalAlign:-1}}/>
            </button>
          </div>

          {deliveriesExpanded && (
            <div style={{display:'flex', gap:4, marginBottom:8, flexWrap:'wrap'}}>
              {['ALL', 'DELIVERED', 'PENDING', 'FAILED'].map((s) => (
                <button
                  key={s}
                  onClick={() => setDeliveryStatus(s)}
                  className={deliveryStatus === s ? 'info-bg' : ''}
                  style={{fontSize:11, padding:'4px 8px'}}
                >
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          )}

          <div className="row-grid header" style={{gridTemplateColumns:'70px 1.3fr 1fr 55px 65px 55px'}}>
            <span>STATUS</span><span>EVENT</span><span>URL</span><span>CODE</span><span>ATTEMPT</span><span>WHEN</span>
          </div>
          {!deliveriesLoading && deliveries.length === 0 && (
            <div style={{padding:20, textAlign:'center', fontSize:11, color:'var(--color-text-tertiary)'}}>
              No webhook deliveries match this filter.
            </div>
          )}
          {deliveries.map((d, i) => (
            <div key={d.id || i} className="row-grid" style={{gridTemplateColumns:'70px 1.3fr 1fr 55px 65px 55px', padding:'calc(var(--row-pad-y, 9px) * 0.8) 0'}}>
              <span className={'pill round ' + (d.status === 'DELIVERED' ? 'success' : d.status === 'FAILED' ? 'danger' : 'warn')} style={{justifySelf:'start'}}>{d.status}</span>
              <code className="mono truncate" style={{fontSize:10}}>{d.event}</code>
              <code className="mono truncate" style={{fontSize:10, color:'var(--color-text-secondary)'}}>{d.host}</code>
              <span style={{fontSize:11}}>{d.code}</span>
              <span style={{fontSize:11, color: d.status === 'FAILED' ? 'var(--color-text-danger)' : d.status === 'PENDING' ? 'var(--color-text-warning)' : 'var(--color-text-secondary)'}}>{d.attempt}</span>
              <span style={{fontSize:10, color:'var(--color-text-tertiary)'}}>{d.when}</span>
            </div>
          ))}
        </div>
      </section>

      {issueOpen && <IssueKeyModal onClose={()=>setIssueOpen(false)} onSubmit={onIssue}/>}
      {subscribeOpen && <SubscribeWebhookModal onClose={()=>setSubscribeOpen(false)} onSubmit={onSubscribe}/>}
      {confirmRevoke && <ConfirmRevokeModal key_={confirmRevoke} onClose={()=>setConfirmRevoke(null)} onConfirm={()=>{
        const target = confirmRevoke;
        setConfirmRevoke(null);
        onRevoke(target);
      }}/>}
    </>
  );
}

// ──────── Reveal callout ────────
function RevealCallout({ reveal, onCopy, onDismiss }) {
  return (
    <div style={{
      background:'color-mix(in srgb, var(--color-background-warning) 50%, transparent)',
      border:'0.5px solid var(--color-border-warning)',
      borderRadius:'var(--border-radius-md)',
      padding:'12px 14px', marginBottom:14
    }}>
      <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
        <Ti name="alert-circle" size={18} style={{color:'var(--color-text-warning)', flexShrink:0, marginTop:1}}/>
        <div style={{flex:1, minWidth:0}}>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
            <p style={{margin:0, fontSize:12, fontWeight:500, color:'var(--color-text-warning)'}}>Copy <span className="mono">{reveal.name}</span> now — it won't be shown again</p>
            <button className="ghost icon-only" onClick={onDismiss} title="Dismiss"><Ti name="x" size={12}/></button>
          </div>
          <p style={{margin:'3px 0 8px', fontSize:11, color:'var(--color-text-secondary)'}}>Sentinel stores only the SHA-256 hash. If you lose this token, you'll need to rotate.</p>
          <div style={{display:'flex', alignItems:'center', gap:6}}>
            <code style={{flex:1, fontFamily:'var(--font-mono)', fontSize:11, background:'var(--color-background-primary)', padding:'8px 10px', borderRadius:'var(--border-radius-md)', border:'0.5px solid var(--color-border-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{reveal.fullKey}</code>
            <button onClick={onCopy} className={reveal.copied ? 'success-bg' : ''} style={{fontSize:11, padding:'7px 10px'}}>
              <Ti name={reveal.copied ? 'check' : 'copy'} size={12}/>
              {reveal.copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────── Webhook card ────────
function WebhookCard({ w, toast, onRemove }) {
  const isFailing = w.status === 'failing';
  const [open, setOpen] = useState(false);
  // Live `GET /v1/admin/webhooks` rows can omit fields the seed mock
  // always carries (`events`, `successRate`, `lastDelivery`, `maxRetries`).
  // Default each one so a sparse row doesn't blow up the render path.
  const events = Array.isArray(w.events) ? w.events : [];
  const successRate = typeof w.successRate === 'number' ? w.successRate : null;
  const lastDelivery = w.lastDelivery || { code: null, when: '—', tone: 'tertiary' };
  return (
    <div style={{
      border: isFailing ? '0.5px solid var(--color-border-danger)' : '0.5px solid var(--color-border-tertiary)',
      borderRadius: 'var(--border-radius-md)',
      padding: '12px 14px',
      background: isFailing ? 'color-mix(in srgb, var(--color-background-danger) 20%, transparent)' : 'transparent'
    }}>
      <div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, marginBottom:8}}>
        <div style={{minWidth:0, flex:1}}>
          <code style={{display:'block', fontFamily:'var(--font-mono)', fontSize:11, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{w.url}</code>
          <div style={{display:'flex', gap:5, marginTop:6, flexWrap:'wrap'}}>
            {events.map(e => (
              <span key={e} className="pill info round" style={{fontSize:10}}>{e}</span>
            ))}
          </div>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:6, flexShrink:0}}>
          <span className={'pill round ' + (successRate == null ? '' : successRate >= 99 ? 'success' : successRate >= 90 ? 'warn' : 'danger')}>{successRate == null ? '—' : successRate + '%'}</span>
          <div style={{position:'relative'}}>
            <button className="ghost icon-only" onClick={()=>setOpen(o => !o)}><Ti name="dots-vertical" size={12}/></button>
            {open && (
              <div onClick={e=>e.stopPropagation()} style={{
                position:'absolute', right:0, top:'calc(100% + 4px)', zIndex:20,
                background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)',
                borderRadius:'var(--border-radius-md)', boxShadow:'var(--shadow-md)', minWidth:160, padding:4, fontSize:12
              }}>
                <div onClick={()=>{ setOpen(false); toast('Sent test event'); }} style={{padding:'6px 10px', borderRadius:4, cursor:'pointer', display:'flex', alignItems:'center', gap:6}}><Ti name="bolt" size={12}/>Send test event</div>
                <div onClick={()=>{ setOpen(false); toast('Retry all queued'); }} style={{padding:'6px 10px', borderRadius:4, cursor:'pointer', display:'flex', alignItems:'center', gap:6}}><Ti name="refresh" size={12}/>Retry failed</div>
                <div style={{height:'0.5px', background:'var(--color-border-tertiary)', margin:'4px 0'}}/>
                <div onClick={()=>{ setOpen(false); onRemove(); }} style={{padding:'6px 10px', borderRadius:4, cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:'var(--color-text-danger)'}}><Ti name="trash" size={12}/>Remove</div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{display:'flex', gap:14, fontSize:10, color:'var(--color-text-secondary)', flexWrap:'wrap'}}>
        <span style={{whiteSpace:'nowrap'}}>Secret: <code className="mono">{w.secret || '—'}</code></span>
        <span style={{whiteSpace:'nowrap'}}>Last delivery: <span style={{color: lastDelivery.tone === 'success' ? 'var(--color-text-success)' : lastDelivery.tone === 'danger' ? 'var(--color-text-danger)' : 'var(--color-text-tertiary)'}}>{lastDelivery.code ? lastDelivery.code + ' · ' : ''}{lastDelivery.when}</span></span>
        <span style={{whiteSpace:'nowrap'}}>Max retries: {w.maxRetries ?? '—'}</span>
      </div>
    </div>
  );
}

// ──────── Menus & modals ────────
function KeyMenu({ key_: _key, onClose, onRotate, onRevoke }) {
  useEffect(() => {
    const close = () => onClose();
    setTimeout(() => window.addEventListener('click', close), 0);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  return (
    <div onClick={e=>e.stopPropagation()} style={{
      position:'absolute', right:0, top:'calc(100% + 4px)', zIndex:20,
      background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)',
      borderRadius:'var(--border-radius-md)', boxShadow:'var(--shadow-md)', minWidth:160, padding:4, fontSize:12
    }}>
      <div style={{padding:'6px 10px', borderRadius:4, cursor:'pointer', display:'flex', alignItems:'center', gap:6}} onClick={onRotate}><Ti name="refresh" size={12}/>Rotate</div>
      <div style={{height:'0.5px', background:'var(--color-border-tertiary)', margin:'4px 0'}}/>
      <div style={{padding:'6px 10px', borderRadius:4, cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:'var(--color-text-danger)'}} onClick={onRevoke}><Ti name="ban" size={12}/>Revoke</div>
    </div>
  );
}

function IssueKeyModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({ name: '', scope: 'predict', rateLimit: 600, expires: 'no expiry' });
  return (
    <Modal
      title="Issue new API key"
      sub={<>The plaintext token is returned exactly once. Sentinel stores only the SHA-256 hash.</>}
      onClose={onClose}
      width={500}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!form.name.trim()} onClick={()=>onSubmit(form)}>Generate key</button>
      </>}
    >
      <Field2 label="Key name">
        <input autoFocus value={form.name} onChange={e=>setForm({...form, name: e.target.value})} placeholder="e.g. checkout-prod"/>
      </Field2>
      <Field2 label="Scope">
        <div style={{display:'flex', gap:6}}>
          {['predict','audit','*'].map(s => (
            <label key={s} style={{
              display:'inline-flex', alignItems:'center', gap:6, padding:'5px 10px',
              border:'0.5px solid var(--color-border-secondary)', borderRadius:'var(--border-radius-md)',
              cursor:'pointer', fontSize:12,
              background: form.scope === s ? 'var(--color-background-info)' : 'transparent',
              color: form.scope === s ? 'var(--color-text-info)' : 'var(--color-text-primary)',
              fontFamily:'var(--font-mono)'
            }}>
              <input type="radio" checked={form.scope === s} onChange={()=>setForm({...form, scope: s})} style={{display:'none'}}/>
              {s}
            </label>
          ))}
        </div>
      </Field2>
      <Field2 label="Rate limit (req/min)">
        <input type="number" value={form.rateLimit} onChange={e=>setForm({...form, rateLimit:+e.target.value})}/>
      </Field2>
      <Field2 label="Expiration">
        <select value={form.expires} onChange={e=>setForm({...form, expires:e.target.value})}>
          <option>no expiry</option>
          <option>30 days</option>
          <option>90 days</option>
          <option>1 year</option>
        </select>
      </Field2>
    </Modal>
  );
}

function SubscribeWebhookModal({ onClose, onSubmit }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(['decision.created']);
  const all = ['decision.created','decision.overridden','model.activated','model.shadowed','report.created','rule.matched','webhook.failed'];
  return (
    <Modal
      title="Subscribe to webhooks"
      sub={<>POSTs are HMAC-signed with the per-subscription secret. Exponential backoff up to 6 retries by default.</>}
      onClose={onClose}
      width={520}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!url.trim() || events.length === 0} onClick={()=>onSubmit({url, events})}>Subscribe</button>
      </>}
    >
      <Field2 label="Endpoint URL">
        <input autoFocus className="mono" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://your-service.example.com/fraud-hook"/>
      </Field2>
      <Field2 label="Events">
        <div style={{display:'flex', flexWrap:'wrap', gap:6}}>
          {all.map(e => {
            const on = events.includes(e);
            return (
              <label key={e} style={{
                display:'inline-flex', alignItems:'center', gap:5, padding:'4px 8px',
                border:'0.5px solid var(--color-border-secondary)', borderRadius:'var(--border-radius-md)',
                cursor:'pointer', fontSize:11, fontFamily:'var(--font-mono)',
                background: on ? 'var(--color-background-info)' : 'transparent',
                color: on ? 'var(--color-text-info)' : 'var(--color-text-primary)'
              }}>
                <input type="checkbox" checked={on} onChange={()=>setEvents(ev => on ? ev.filter(x => x !== e) : [...ev, e])} style={{display:'none'}}/>
                {on && <Ti name="check" size={10}/>}
                {e}
              </label>
            );
          })}
        </div>
      </Field2>
    </Modal>
  );
}

function ConfirmRevokeModal({ key_, onClose, onConfirm }) {
  const [typed, setTyped] = useState('');
  return (
    <Modal
      title="Revoke API key"
      sub={<>Any service still using this key will start receiving <code className="mono">401</code> on next request. This cannot be undone.</>}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="danger-bg" disabled={typed !== key_.name} onClick={onConfirm}>Revoke key</button>
      </>}
    >
      <p style={{margin:'0 0 8px', fontSize:12}}>Type <code className="mono" style={{background:'var(--color-background-secondary)', padding:'1px 6px', borderRadius:3}}>{key_.name}</code> to confirm.</p>
      <input autoFocus value={typed} onChange={e=>setTyped(e.target.value)} style={{width:'100%'}}/>
    </Modal>
  );
}

function Field2({ label, children }) {
  return (
    <div style={{marginBottom:10}}>
      <label className="label-up" style={{display:'block', marginBottom:5}}>{label}</label>
      {React.cloneElement(children, { style: { width: '100%', ...(children.props.style || {}) } })}
    </div>
  );
}

// Server delivery rows use a richer schema than the seed mocks. Normalise
// them into the `{status, event, host, code, attempt, when}` shape the
// table already renders so we don't have to touch the row template.
function normaliseDelivery(d) {
  const url = d.url || '';
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url.replace(/^https?:\/\//, '').split('/')[0];
    }
  })();
  const when = d.lastAttemptedAt
    ? new Date(d.lastAttemptedAt).toLocaleTimeString('en-GB', { hour12: false })
    : d.createdAt
    ? new Date(d.createdAt).toLocaleTimeString('en-GB', { hour12: false })
    : '—';
  return {
    status: d.status,
    event: d.event,
    host,
    code: d.lastResponseCode ?? '—',
    attempt: `${d.attempts ?? 0}/${d.maxRetries ?? 6}`,
    when,
  };
}

export default Integrations;
