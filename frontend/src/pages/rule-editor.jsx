// Page 5 — Rule editor (JSON-Logic DSL, Sentinel style)

import React, { useState, useEffect, useMemo } from 'react';
import { Ti, PageHead, Modal, actionPill, hasPermission, permLock } from '../components/shell.jsx';
import { SearchInput } from '../components/search-input.jsx';
import { saveRule, deleteRule, setRuleActive } from '../api/client.js';
import { RuleBuilder, fromJsonLogic, toJsonLogic } from './rule-builder.jsx';
import { EXAMPLES } from './rule-templates.js';

const RULE_OPS = ['var','==','!=','>','>=','<','<=','and','or','not','in'];

const KNOWN_VARS = {
  PRE: ['sender_id','receiver_id','amount','transaction_type','segment','features.amount_24h_sum','features.velocity_zscore','features.beneficiary_first_send','features.account_age_days','features.ip_asn','features.ip_country','features.ip_is_vpn','features.sender_country','features.txns_1h_count','features.receiver_id','config.vendor_ids'],
  POST: ['sender_id','receiver_id','amount','transaction_type','segment','features.amount_24h_sum','features.velocity_zscore','features.beneficiary_first_send','features.account_age_days','features.ip_asn','features.ip_country','features.ip_is_vpn','features.sender_country','features.txns_1h_count','features.receiver_id','ml_score','ml_decision','config.vendor_ids']
};

const SAMPLE_TX = {
  sender_id: 'user_acme_42', receiver_id: 'acct_mule_a', amount: 250000, transaction_type: 'TRANSFER',
  segment: 'p2p_transfer', ml_score: 0.91, ml_decision: 'DECLINE',
  features: {
    amount_24h_sum: 870000, velocity_zscore: 4.3, beneficiary_first_send: true, account_age_days: 11,
    ip_asn: 56789, ip_country: 'NL', ip_is_vpn: true, sender_country: 'NG', txns_1h_count: 8, receiver_id: 'acct_mule_a'
  },
  config: { vendor_ids: ['acct_glassmark','acct_helios_food'] }
};

// Pretty JSON
function jsonRender(obj, depth = 0) {
  const indent = '  '.repeat(depth);
  if (obj === null) return <span style={{color:'var(--color-text-tertiary)'}}>null</span>;
  if (typeof obj === 'boolean') return <span style={{color:'var(--ink-secondary)', fontWeight:500}}>{String(obj)}</span>;
  if (typeof obj === 'number') return <span style={{color:'var(--color-text-info)'}}>{obj}</span>;
  if (typeof obj === 'string') return <span style={{color:'var(--color-text-success)'}}>"{obj}"</span>;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return <>[]</>;
    return <>[{obj.map((v, i) => (
      <React.Fragment key={i}>{'\n' + indent + '  '}{jsonRender(v, depth+1)}{i < obj.length-1 ? ',' : ''}</React.Fragment>
    ))}{'\n' + indent}]</>;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return <>{'{}'}</>;
    return <>{'{'}{keys.map((k, i) => {
      const isOp = RULE_OPS.includes(k);
      return (
        <React.Fragment key={k}>{'\n' + indent + '  '}
          <span style={{color: isOp ? 'var(--color-text-danger)' : 'var(--color-text-primary)', fontWeight: isOp ? 600 : 500}}>"{k}"</span>: {jsonRender(obj[k], depth+1)}{i < keys.length-1 ? ',' : ''}
        </React.Fragment>
      );
    })}{'\n' + indent + '}'}</>;
  }
  return String(obj);
}

// Reads-as
function readsAs(node) {
  if (node === null || node === undefined) return 'nothing';
  if (typeof node !== 'object') return JSON.stringify(node);
  if (Array.isArray(node)) return node.map(readsAs).join(', ');
  const op = Object.keys(node)[0];
  const args = node[op];
  if (op === 'var') return <code className="mono" style={{background:'var(--color-background-secondary)', padding:'1px 6px', borderRadius:3, fontSize:11.5}}>{args}</code>;
  const cmpWords = {'==':'equals','!=':'is not','>':'is greater than','>=':'is at least','<':'is less than','<=':'is at most'};
  if (cmpWords[op]) return <>{readsAs(args[0])} <b style={{color:'var(--color-text-info)'}}>{cmpWords[op]}</b> {readsAs(args[1])}</>;
  if (op === 'in') {
    const list = Array.isArray(args[1]) ? args[1] : null;
    return <>{readsAs(args[0])} <b style={{color:'var(--color-text-info)'}}>is one of</b> {list ? <>[{list.slice(0,3).map((v,i)=><span key={i}>{i>0?', ':''}{readsAs(v)}</span>)}{list.length>3?', …':''}]</> : readsAs(args[1])}</>;
  }
  if (op === 'and' || op === 'or') {
    return (
      <span>
        <b style={{color:'var(--color-text-info)'}}>{op === 'and' ? 'all of' : 'any of'}</b>
        <ul style={{margin:'4px 0 0 18px', padding:0}}>
          {args.map((a, i) => <li key={i} style={{marginBottom:3}}>{readsAs(a)}</li>)}
        </ul>
      </span>
    );
  }
  if (op === 'not') return <><b style={{color:'var(--color-text-info)'}}>not</b> {readsAs(args)}</>;
  return JSON.stringify(node);
}

function collectVars(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(n => collectVars(n, acc)); return acc; }
  for (const k of Object.keys(node)) {
    if (k === 'var') acc.push(node[k]);
    else collectVars(node[k], acc);
  }
  return acc;
}

function ruleEval(expr, ctx) {
  if (expr === null || typeof expr !== 'object') return expr;
  if (Array.isArray(expr)) return expr.map(e => ruleEval(e, ctx));
  const op = Object.keys(expr)[0]; const a = expr[op];
  const get = (p) => String(p).split('.').reduce((o, k) => o == null ? undefined : o[k], ctx);
  switch (op) {
    case 'var': return get(a);
    case '==': return ruleEval(a[0], ctx) == ruleEval(a[1], ctx);
    case '!=': return ruleEval(a[0], ctx) != ruleEval(a[1], ctx);
    case '>': return ruleEval(a[0], ctx) > ruleEval(a[1], ctx);
    case '>=': return ruleEval(a[0], ctx) >= ruleEval(a[1], ctx);
    case '<': return ruleEval(a[0], ctx) < ruleEval(a[1], ctx);
    case '<=': return ruleEval(a[0], ctx) <= ruleEval(a[1], ctx);
    case 'and': return a.every(x => !!ruleEval(x, ctx));
    case 'or': return a.some(x => !!ruleEval(x, ctx));
    case 'not': return !ruleEval(a, ctx);
    case 'in': {
      const v = ruleEval(a[0], ctx); const set = ruleEval(a[1], ctx);
      return Array.isArray(set) ? set.includes(v) : false;
    }
    default: return undefined;
  }
}

function RuleEditor({ toast, rules, setRules, user }) {
  const canCreate = hasPermission(user, 'rules:create');
  const canUpdate = hasPermission(user, 'rules:update');
  const canDelete = hasPermission(user, 'rules:delete');
  const [activeId, setActiveId] = useState(rules[0]?.id);
  const [editorJson, setEditorJson] = useState(JSON.stringify(rules[0]?.expression, null, 2));
  const [name, setName] = useState(rules[0]?.name);
  const [action, setAction] = useState(rules[0]?.action);
  const [stage, setStage] = useState(rules[0]?.stage);
  const [priority, setPriority] = useState(rules[0]?.priority);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [countdown, setCountdown] = useState(18);
  const [showDelete, setShowDelete] = useState(false);
  const [search, setSearch] = useState('');
  // Which tab is open on the editor pane: 'visual' (form), 'json' (raw
  // editor), 'examples' (preset palette). Defaults to 'visual' for new
  // analysts; falls back to 'json' automatically when the current
  // expression is too complex for the flat builder to render.
  const [editMode, setEditMode] = useState('visual');

  const active = rules.find(r => r.id === activeId);

  useEffect(() => {
    if (!active) return;
    setEditorJson(JSON.stringify(active.expression, null, 2));
    setName(active.name); setAction(active.action); setStage(active.stage); setPriority(active.priority);
    setDirty(false);
  }, [activeId]);

  useEffect(() => {
    const t = setInterval(() => setCountdown(c => c <= 1 ? 30 : c - 1), 1000);
    return () => clearInterval(t);
  }, []);

  const parsed = useMemo(() => {
    try { return { ok: true, value: JSON.parse(editorJson) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }, [editorJson]);

  const testResult = useMemo(() => {
    if (!parsed.ok) return { state: 'error', message: 'Invalid JSON' };
    try {
      const out = ruleEval(parsed.value, SAMPLE_TX);
      return { state: 'ok', matched: !!out };
    } catch (e) { return { state: 'error', message: e.message }; }
  }, [parsed]);

  const varIssues = useMemo(() => {
    if (!parsed.ok) return [];
    const vars = collectVars(parsed.value);
    const known = new Set(KNOWN_VARS[stage]);
    const unknown = vars.filter(v => !known.has(v));
    const postOnly = ['ml_score','ml_decision'];
    const usedPostOnly = stage === 'PRE' ? vars.filter(v => postOnly.includes(v)) : [];
    return [
      ...unknown.map(v => ({ kind:'unknown', path:v })),
      ...usedPostOnly.map(v => ({ kind:'post-only', path:v }))
    ];
  }, [parsed, stage]);

  const filteredRules = rules.filter(r => !search || (r.name || '').toLowerCase().includes(search.toLowerCase()));

  const onSave = async () => {
    if (!parsed.ok) {
      toast('Cannot save · invalid JSON', 'danger');
      return;
    }
    // The server returns the persisted row — including the real id when
    // we're creating from a synthetic `r_new_…` placeholder. Replace the
    // local row with whatever the server has so subsequent edits / toggles
    // hit the right path.
    const payload = { id: activeId, expression: parsed.value, name, action, stage, priority };
    setSaving(true);
    try {
      let saved;
      try {
        saved = await saveRule(payload);
      } catch (err) {
        // Don't swallow — if the user clicked Save and it didn't persist,
        // they need to know. Keep the local edit so they can retry.
        const msg = String(err?.message || err);
        toast(`Save failed · ${msg.slice(0, 200)}`, 'danger');
        return;
      }
      setRules((rs) => {
        // If we were saving a synthetic placeholder, swap it for the
        // server's row; otherwise patch in place.
        const replaceId = activeId;
        const next = saved || { ...payload, updatedAt: new Date().toISOString().slice(0, 10) };
        const hit = rs.some((r) => r.id === replaceId);
        if (hit) return rs.map((r) => (r.id === replaceId ? { ...r, ...next } : r));
        return [next, ...rs];
      });
      if (saved?.id && saved.id !== activeId) setActiveId(saved.id);
      setDirty(false);
      toast(`Saved · ${name} · hot-reload in ${countdown}s`, 'success');
    } finally {
      setSaving(false);
    }
  };

  // Toggle a rule's `isActive` flag via PATCH. Optimistic update with a
  // rollback on failure so the user sees the switch flip immediately but
  // never ends up with a UI state that disagrees with the server.
  const onToggleActive = async (rule) => {
    const previous = rule.isActive;
    setRules((rs) => rs.map((x) => (x.id === rule.id ? { ...x, isActive: !previous } : x)));
    try {
      const updated = await setRuleActive(rule.id, !previous);
      setRules((rs) => rs.map((x) => (x.id === rule.id ? { ...x, ...updated } : x)));
      toast(
        `${rule.name} ${!previous ? 'enabled' : 'disabled'}${countdown ? ` · hot-reload in ${countdown}s` : ''}`,
        !previous ? 'success' : 'warn',
      );
    } catch (err) {
      // Revert the optimistic flip and tell the user why.
      setRules((rs) => rs.map((x) => (x.id === rule.id ? { ...x, isActive: previous } : x)));
      toast(`Toggle failed · ${String(err?.message || err).slice(0, 200)}`, 'danger');
    }
  };

  const onCreate = () => {
    const id = 'r_new_' + Math.floor(Math.random() * 9999);
    const next = {
      id,
      name: 'untitled-rule',
      stage: 'POST',
      action: 'REVIEW',
      priority: 100,
      isActive: false,
      matches7d: 0,
      updatedAt: new Date().toISOString().slice(0, 10),
      expression: { '==': [{ var: 'segment' }, 'p2p_transfer'] },
    };
    setRules((rs) => [next, ...rs]);
    setActiveId(id);
    // Pre-populate the editor's local state. Without this, the first
    // render after the rules array transitions from [] to [new] still
    // holds the `undefined` initial values captured at mount, which
    // makes the editor look blank.
    setEditorJson(JSON.stringify(next.expression, null, 2));
    setName(next.name);
    setAction(next.action);
    setStage(next.stage);
    setPriority(next.priority);
    setDirty(true);
  };

  // Empty state: no rules in the database yet. Otherwise the page renders
  // a blank right pane because `active` is undefined.
  if (rules.length === 0) {
    return (
      <>
        <PageHead crumbs={['Dashboard', 'Config']} title="Rules" sub="JSON-Logic expressions evaluated by the decision engine">
          <button className="info-bg" onClick={onCreate} {...permLock(user, 'rules:create')}><Ti name="plus" size={14}/>New rule</button>
        </PageHead>
        <div className="panel" style={{textAlign:'center', padding:'48px 24px'}}>
          <div style={{
            width:48, height:48, margin:'0 auto 14px', borderRadius:'50%',
            background:'var(--color-background-info)', color:'var(--color-text-info)',
            display:'inline-flex', alignItems:'center', justifyContent:'center'
          }}>
            <Ti name="shield-check" size={20}/>
          </div>
          <h3 style={{margin:'0 0 4px', fontSize:16, fontWeight:500}}>No rules yet</h3>
          <p style={{margin:'0 auto', maxWidth:360, fontSize:12, color:'var(--color-text-secondary)', lineHeight:1.55}}>
            Rules are JSON-Logic expressions evaluated before (PRE) or after (POST) the ML model. Click <b>New rule</b> to add your first one — it lives on disk only after you press Save.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead crumbs={['Dashboard','Config']} title="Rules" sub="JSON-Logic expressions evaluated by the decision engine">
        <div style={{display:'flex', alignItems:'center', gap:6, fontSize:11, color:'var(--color-text-secondary)', padding:'0 8px', whiteSpace:'nowrap'}}>
          <Ti name="refresh" size={12}/>
          <span>Hot-reload in <span className="mono" style={{color:'var(--color-text-primary)'}}>{countdown}s</span></span>
        </div>
        <button><Ti name="history" size={14}/>History</button>
        <button className="info-bg" onClick={onCreate} {...permLock(user, 'rules:create')}><Ti name="plus" size={14}/>New rule</button>
      </PageHead>

      <div style={{display:'grid', gridTemplateColumns:'minmax(280px, 340px) 1fr', gap:12, alignItems:'flex-start'}}>
        {/* LEFT — list */}
        <aside className="panel" style={{padding:0, display:'flex', flexDirection:'column', maxHeight:'calc(100vh - 140px)'}}>
          <div style={{padding:'10px 12px', borderBottom:'0.5px solid var(--color-border-tertiary)', display:'flex', gap:8}}>
            <SearchInput
              value={search}
              onCommit={setSearch}
              placeholder="Filter rules… (Enter)"
              hint="Press Enter to filter"
            />
          </div>
          <div style={{flex:1, overflow:'auto', minHeight:0}}>
            <div className="row-grid header" style={{gridTemplateColumns:'28px 1fr 70px 60px', padding:'calc(var(--row-pad-y, 9px) * 0.7) 12px'}}>
              <span></span>
              <span>RULE</span>
              <span>ACTION</span>
              <span style={{textAlign:'right'}}>7D</span>
            </div>
            {filteredRules.map(r => (
              <div key={r.id} onClick={()=>setActiveId(r.id)} className="row-grid" style={{
                gridTemplateColumns:'28px 1fr 70px 60px',
                padding:'var(--row-pad-y, 9px) 12px',
                cursor:'pointer',
                background: r.id === activeId ? 'color-mix(in srgb, var(--color-background-info) 30%, transparent)' : 'transparent',
                borderLeft: r.id === activeId ? '2px solid var(--color-text-info)' : '2px solid transparent'
              }}>
                <div
                  className={'toggle ' + (r.isActive ? 'on' : '')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canUpdate) {
                      toast('Requires "rules:update" — ask an administrator.', 'danger');
                      return;
                    }
                    onToggleActive(r);
                  }}
                  title={canUpdate ? `Click to ${r.isActive ? 'disable' : 'enable'}` : 'Requires rules:update'}
                />
                <div style={{minWidth:0}}>
                  <div style={{fontSize:12, fontWeight:500, color: r.isActive ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)'}} className="truncate">{r.name}</div>
                  <div style={{fontSize:10, color:'var(--color-text-tertiary)', display:'flex', gap:5, marginTop:2, whiteSpace:'nowrap'}}>
                    <span className="pill" style={{padding:'1px 5px', fontSize:9}}>{r.stage}</span>
                    <span className="mono">prio&nbsp;{r.priority}</span>
                  </div>
                </div>
                {actionPill(r.action)}
                <span className="mono tnum" style={{textAlign:'right', fontSize:11, color:'var(--color-text-secondary)'}}>{(r.matches7d ?? 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* RIGHT — editor */}
        {active && (
          <main style={{minWidth:0, display:'flex', flexDirection:'column', gap:12}}>
            <div className="panel">
              <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10}}>
                <input
                  value={name}
                  onChange={e=>{setName(e.target.value); setDirty(true);}}
                  style={{flex:1, fontSize:18, fontWeight:500, letterSpacing:'-0.01em', border:'none', background:'transparent', padding:0}}
                  className="mono"
                />
                <span style={{fontSize:11, color:'var(--color-text-tertiary)'}}>updated {active.updatedAt}</span>
                {dirty && <span className="pill warn">unsaved</span>}
              </div>
              <div style={{display:'flex', alignItems:'center', gap:14}}>
                <FieldRow label="Stage">
                  <Segmented value={stage} options={['PRE','POST']} onChange={s=>{setStage(s); setDirty(true);}}/>
                </FieldRow>
                <FieldRow label="Action">
                  <select value={action} onChange={e=>{setAction(e.target.value); setDirty(true);}} style={{fontSize:12, padding:'4px 8px'}}>
                    <option>ALLOW</option><option>DENY</option><option>REVIEW</option><option>NONE</option>
                  </select>
                </FieldRow>
                <FieldRow label="Priority">
                  <input type="number" className="mono" value={priority} onChange={e=>{setPriority(+e.target.value); setDirty(true);}} style={{width:60, fontSize:12, padding:'4px 8px'}}/>
                </FieldRow>
                <span className="spacer"/>
                <button
                  onClick={()=>setShowDelete(true)}
                  style={{color: canDelete ? 'var(--color-text-danger)' : undefined}}
                  {...permLock(user, 'rules:delete')}
                >Delete</button>
                <button
                  className="primary"
                  onClick={onSave}
                  disabled={saving || !parsed.ok || !dirty || !canUpdate}
                  title={!canUpdate ? 'Requires "rules:update" — ask an administrator.' : ''}
                >
                  <Ti name={saving ? 'loader-2' : 'device-floppy'} size={14} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            {varIssues.length > 0 && (
              <div className="banner warn">
                <Ti name="alert-triangle" size={14} className="b-icon"/>
                <div style={{flex:1}}>
                  <b>{varIssues.length} validation warning{varIssues.length>1?'s':''}</b>
                  <ul style={{margin:'4px 0 0 16px', padding:0, lineHeight:1.6}}>
                    {varIssues.map((iss, i) => (
                      <li key={i}>
                        {iss.kind === 'unknown' && <>Unknown variable <code className="mono" style={{background:'rgba(255,255,255,0.4)', padding:'1px 5px', borderRadius:3}}>{iss.path}</code> — server will silently skip this rule.</>}
                        {iss.kind === 'post-only' && <>Variable <code className="mono" style={{background:'rgba(255,255,255,0.4)', padding:'1px 5px', borderRadius:3}}>{iss.path}</code> only exists at POST stage.</>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
              {/* Expression editor — Visual builder / JSON / Examples */}
              <div className="panel" style={{padding:0, overflow:'hidden'}}>
                <div className="panel-head" style={{padding:'8px 8px 8px 14px', borderBottom:'0.5px solid var(--color-border-tertiary)', margin:0}}>
                  <h2 style={{flexShrink:0}}>Expression</h2>
                  <div style={{display:'flex', alignItems:'center', gap:4, marginLeft:'auto'}}>
                    {[
                      { id: 'visual', label: 'Visual',   icon: 'forms' },
                      { id: 'json',   label: 'JSON',     icon: 'braces' },
                      { id: 'examples', label: 'Examples', icon: 'sparkles' },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setEditMode(tab.id)}
                        className={editMode === tab.id ? 'info-bg' : ''}
                        style={{fontSize:11, padding:'4px 8px'}}
                        title={tab.label}
                      >
                        <Ti name={tab.icon} size={12}/>{tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {editMode === 'visual' && (
                  <div style={{padding:'12px 14px', minHeight:300}}>
                    {parsed.ok ? (
                      <RuleBuilder
                        expression={parsed.value}
                        knownVars={KNOWN_VARS[stage]}
                        disabled={!canUpdate}
                        onChange={(model) => {
                          const next = toJsonLogic(model);
                          if (next == null) return;
                          setEditorJson(JSON.stringify(next, null, 2));
                          setDirty(true);
                        }}
                      />
                    ) : (
                      <div className="banner danger">
                        <Ti name="alert-circle" size={14} className="b-icon"/>
                        <div>
                          <b>Invalid JSON</b>
                          <p style={{margin:'2px 0 0', fontSize:11}}>{parsed.error}. Fix it in the JSON tab to use the visual editor.</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {editMode === 'json' && (
                  <>
                    <div style={{position:'relative', minHeight:300}}>
                      <pre style={{margin:0, padding:'12px 14px', fontFamily:'var(--font-mono)', fontSize:12, lineHeight:1.6, position:'absolute', inset:0, pointerEvents:'none', whiteSpace:'pre-wrap', wordBreak:'break-word', color: parsed.ok ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', tabSize:2}}>
                        {parsed.ok ? jsonRender(parsed.value) : editorJson}
                      </pre>
                      <textarea
                        value={editorJson}
                        onChange={e=>{ setEditorJson(e.target.value); setDirty(true); }}
                        spellCheck="false"
                        style={{
                          width:'100%', height:'100%', minHeight:300,
                          padding:'12px 14px', fontFamily:'var(--font-mono)', fontSize:12, lineHeight:1.6,
                          border:'none', outline:'none', background:'transparent',
                          color:'transparent', caretColor:'var(--color-text-primary)',
                          resize:'none', position:'relative', whiteSpace:'pre-wrap', wordBreak:'break-word'
                        }}
                      />
                    </div>
                    {!parsed.ok && (
                      <div style={{padding:'8px 14px', background:'var(--color-background-danger)', color:'var(--color-text-danger)', fontSize:11, fontFamily:'var(--font-mono)', borderTop:'0.5px solid var(--color-border-danger)'}}>
                        <Ti name="alert-circle" size={11} style={{marginRight:6, verticalAlign:-1}}/>
                        {parsed.error}
                      </div>
                    )}
                  </>
                )}

                {editMode === 'examples' && (
                  <ExamplePalette
                    stage={stage}
                    canUpdate={canUpdate}
                    onUse={(ex) => {
                      // Drop the example into the JSON editor and the
                      // action/stage controls. Stay on the Examples tab
                      // for a beat so the user sees confirmation, then
                      // hop them back to Visual.
                      setEditorJson(JSON.stringify(ex.expression, null, 2));
                      if (ex.action) setAction(ex.action);
                      if (ex.for) setStage(ex.for);
                      setDirty(true);
                      setEditMode('visual');
                      toast(`Loaded example · ${ex.title}`, 'success');
                    }}
                    onCopy={(ex) => {
                      navigator.clipboard?.writeText(
                        JSON.stringify(ex.expression, null, 2),
                      );
                      toast('Copied to clipboard', 'success');
                    }}
                  />
                )}
              </div>

              <div style={{display:'flex', flexDirection:'column', gap:12}}>
                <div className="panel">
                  <div className="panel-head">
                    <h2>Reads as</h2>
                    <span style={{fontSize:10, color:'var(--color-text-tertiary)'}}>plain English</span>
                  </div>
                  <div style={{fontSize:12.5, lineHeight:1.7, color:'var(--color-text-secondary)'}}>
                    <span style={{color:'var(--color-text-tertiary)'}}>If </span>
                    {parsed.ok ? readsAs(parsed.value) : <span className="muted">— resolve JSON errors —</span>}
                    <span style={{color:'var(--color-text-tertiary)'}}> then </span>
                    {actionPill(action)}
                    <span style={{color:'var(--color-text-tertiary)'}}> at </span>
                    <span className="pill">{stage}</span>.
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>Test run</h2>
                    {testResult.state === 'ok'
                      ? (testResult.matched
                          ? <span className="pill danger dot">Matched · {action}</span>
                          : <span className="pill success dot">No match</span>)
                      : <span className="pill warn">{testResult.message}</span>}
                  </div>
                  <details>
                    <summary style={{fontSize:11, color:'var(--color-text-tertiary)', cursor:'pointer', userSelect:'none'}}>sample transaction</summary>
                    <pre style={{margin:'8px 0 0', padding:'10px 12px', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--color-text-secondary)', background:'var(--color-background-secondary)', borderRadius:'var(--border-radius-md)', maxHeight:220, overflow:'auto', whiteSpace:'pre-wrap'}}>{JSON.stringify(SAMPLE_TX, null, 2)}</pre>
                  </details>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>Variables</h2>
                    <span style={{fontSize:10, color:'var(--color-text-tertiary)'}}>{stage} stage</span>
                  </div>
                  <div style={{display:'flex', flexWrap:'wrap', gap:4}}>
                    {KNOWN_VARS[stage].map(v => (
                      <span key={v} className="mono" style={{
                        background:'var(--color-background-secondary)', padding:'2px 7px', borderRadius:3, fontSize:11,
                        color: ['ml_score','ml_decision'].includes(v) ? 'var(--color-text-info)' : 'var(--color-text-secondary)'
                      }}>{v}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="banner" style={{padding:'9px 12px', fontSize:11}}>
              <Ti name="info-circle" size={12} className="b-icon" style={{color:'var(--color-text-tertiary)'}}/>
              <span><b>Tip:</b> disable + don't delete is the recommended path — rules can be referenced from audit history. Server is authoritative on validation; bad rules are silently skipped at runtime.</span>
            </div>
          </main>
        )}
      </div>

      {showDelete && (
        <DeleteRuleModal name={active.name} onClose={()=>setShowDelete(false)} onConfirm={async ()=>{
          setShowDelete(false);
          try { await deleteRule(activeId); } catch { /* tolerate offline */ }
          setRules(rs => rs.filter(r => r.id !== activeId));
          const next = rules.find(r => r.id !== activeId);
          if (next) setActiveId(next.id);
          toast(`Deleted · ${active.name}`, 'danger');
        }}/>
      )}
    </>
  );
}

function FieldRow({ label, children }) {
  return (
    <div style={{display:'flex', alignItems:'center', gap:6}}>
      <span className="label-up" style={{textTransform:'uppercase'}}>{label}</span>
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div style={{display:'flex', border:'0.5px solid var(--color-border-secondary)', borderRadius:'var(--border-radius-md)', overflow:'hidden'}}>
      {options.map((o, i) => (
        <button key={o} onClick={()=>onChange(o)} style={{
          padding:'4px 10px', fontSize:11, fontWeight:value===o?500:400, borderRadius:0,
          background: value === o ? 'var(--color-text-primary)' : 'transparent',
          color: value === o ? 'var(--color-background-primary)' : 'var(--color-text-secondary)',
          border:'none', borderLeft: i > 0 ? '0.5px solid var(--color-border-secondary)' : 'none', boxShadow:'none'
        }}>{o}</button>
      ))}
    </div>
  );
}

function DeleteRuleModal({ name, onClose, onConfirm }) {
  const [typed, setTyped] = useState('');
  return (
    <Modal
      title="Delete rule"
      sub="Rules can be referenced from audit history. Disabling is usually safer."
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="danger-bg" disabled={typed !== name} onClick={onConfirm}>Delete permanently</button>
      </>}
    >
      <p style={{margin:'0 0 8px', fontSize:12}}>To confirm, type the rule name: <code className="mono" style={{background:'var(--color-background-secondary)', padding:'1px 6px', borderRadius:3}}>{name}</code></p>
      <input autoFocus style={{width:'100%'}} value={typed} onChange={e=>setTyped(e.target.value)} placeholder={name}/>
    </Modal>
  );
}

/**
 * Curated library of preset JSON-Logic rules. Each card shows the
 * expression, its action, the stage it's meant for, and two actions:
 * "Use this" drops the example into the editor; "Copy JSON" puts the
 * raw expression on the clipboard so the analyst can paste it
 * anywhere.
 */
function ExamplePalette({ stage, canUpdate, onUse, onCopy }) {
  const [filter, setFilter] = useState('ALL');
  const shown = filter === 'ALL' ? EXAMPLES : EXAMPLES.filter((e) => e.for === filter);
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="label-up" style={{ fontSize: 10 }}>FILTER</span>
        {[
          { k: 'ALL', label: 'All' },
          { k: 'PRE', label: `PRE-stage` },
          { k: 'POST', label: 'POST-stage' },
        ].map((b) => (
          <button
            key={b.k}
            onClick={() => setFilter(b.k)}
            className={filter === b.k ? 'info-bg' : ''}
            style={{ fontSize: 11, padding: '3px 8px' }}
          >
            {b.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {shown.length} example{shown.length === 1 ? '' : 's'} · current stage <code className="mono">{stage}</code>
        </span>
      </div>

      {shown.length === 0 && (
        <p style={{ margin: 0, padding: 20, textAlign: 'center', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          No examples for this stage.
        </p>
      )}

      {shown.map((ex) => (
        <article
          key={ex.title}
          style={{
            border: '0.5px solid var(--color-border-tertiary)',
            borderRadius: 'var(--border-radius-md)',
            padding: '10px 12px',
            background: 'var(--color-background-secondary)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: 12, fontWeight: 500 }}>{ex.title}</p>
              <p style={{ margin: '2px 0 4px', fontSize: 11, color: 'var(--color-text-secondary)' }}>{ex.description}</p>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <span className="pill" style={{ fontSize: 9, padding: '1px 6px' }}>{ex.for}</span>
                <span
                  className={
                    'pill ' +
                    (ex.action === 'DENY'
                      ? 'danger'
                      : ex.action === 'ALLOW'
                        ? 'success'
                        : 'warn')
                  }
                  style={{ fontSize: 9, padding: '1px 6px' }}
                >
                  {ex.action}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
              <button
                disabled={!canUpdate}
                onClick={() => onUse(ex)}
                className="primary"
                style={{ fontSize: 11, padding: '4px 10px' }}
                title={canUpdate ? 'Drop this into the editor' : 'Requires rules:update'}
              >
                Use this
              </button>
              <button
                onClick={() => onCopy(ex)}
                style={{ fontSize: 11, padding: '4px 10px' }}
                title="Copy the JSON-Logic to clipboard"
              >
                <Ti name="copy" size={11} />Copy JSON
              </button>
            </div>
          </div>
          <pre
            className="mono"
            style={{
              margin: '8px 0 0',
              padding: '8px 10px',
              fontSize: 10,
              lineHeight: 1.55,
              background: 'var(--color-background-primary)',
              border: '0.5px solid var(--color-border-tertiary)',
              borderRadius: 4,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(ex.expression, null, 2)}
          </pre>
        </article>
      ))}
    </div>
  );
}

export default RuleEditor;
