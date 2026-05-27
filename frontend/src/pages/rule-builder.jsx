// Visual rule builder — for analysts who don't want to write JSON-Logic.
//
// Renders the rule as a list of `<field> <op> <value>` clauses joined
// by a single AND/OR connector, compiles to JSON-Logic on every edit,
// and falls back to a friendly "switch to JSON" banner when the
// current expression is too complex for the flat model. Source of
// truth stays the JSON expression — the builder is just a different
// view onto it.

import { useMemo } from 'react';
import { Ti } from '../components/shell.jsx';
import { OPS, coerceLiteral, coerceList, fromJsonLogic, toJsonLogic } from './rule-templates.js';

const NUMERIC_HINT_FIELDS = new Set([
  'amount',
  'ml_score',
  'features.amount_24h_sum',
  'features.velocity_zscore',
  'features.account_age_days',
  'features.txns_1h_count',
  'features.ip_asn',
]);

const BOOLEAN_HINT_FIELDS = new Set([
  'features.beneficiary_first_send',
  'features.ip_is_vpn',
]);

function isBooleanField(field) {
  return BOOLEAN_HINT_FIELDS.has(field);
}

function isNumericField(field) {
  return NUMERIC_HINT_FIELDS.has(field);
}

/**
 * Render value input matched to the field's expected type. We don't
 * fight the user — they can always type "true" / "false" or a number
 * in any input and the coercer handles it.
 */
function ValueInput({ field, op, value, onChange, disabled }) {
  if (op === 'in' || op === 'not_in') {
    const display = Array.isArray(value) ? value.join(', ') : '';
    return (
      <input
        type="text"
        disabled={disabled}
        value={display}
        onChange={(e) => onChange(coerceList(e.target.value))}
        placeholder="comma-separated values"
        style={{ width: '100%' }}
      />
    );
  }
  if (isBooleanField(field)) {
    return (
      <select
        disabled={disabled}
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')}
        style={{ width: '100%' }}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      type={isNumericField(field) ? 'number' : 'text'}
      step={isNumericField(field) ? 'any' : undefined}
      disabled={disabled}
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(coerceLiteral(e.target.value))}
      placeholder={isNumericField(field) ? '0' : 'value'}
      style={{ width: '100%' }}
    />
  );
}

function RuleBuilder({ expression, knownVars, onChange, disabled }) {
  // Decode the JSON-Logic expression into the flat model the builder
  // can represent. Memo keeps the deserialize stable when nothing
  // changed upstream.
  const parsed = useMemo(() => fromJsonLogic(expression), [expression]);

  if (!parsed.ok) {
    return (
      <div className="banner warn">
        <Ti name="alert-triangle" size={14} className="b-icon" />
        <div style={{ flex: 1 }}>
          <b>This rule is too complex for the visual editor.</b>
          <p style={{ margin: '4px 0 0', fontSize: 12 }}>
            The visual builder supports a flat list of <code className="mono">field op value</code>{' '}
            clauses joined by a single AND / OR. Reason: {parsed.reason}. Edit the JSON tab to
            modify this rule, or start fresh from the Reset button below.
          </p>
          <button
            disabled={disabled}
            onClick={() =>
              onChange({
                connector: 'AND',
                clauses: [{ field: knownVars[0] || 'amount', op: '>=', value: 0 }],
              })
            }
            style={{ marginTop: 8, fontSize: 11, padding: '4px 8px' }}
          >
            Reset to a single clause
          </button>
        </div>
      </div>
    );
  }

  const { connector, clauses } = parsed;

  const update = (next) => onChange(next);
  const setConnector = (v) => update({ connector: v, clauses });
  const setClause = (idx, patch) =>
    update({
      connector,
      clauses: clauses.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    });
  const addClause = () =>
    update({
      connector,
      clauses: [...clauses, { field: knownVars[0] || 'amount', op: '>=', value: 0 }],
    });
  const removeClause = (idx) =>
    update({ connector, clauses: clauses.filter((_, i) => i !== idx) });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {clauses.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="label-up" style={{ fontSize: 10 }}>
            MATCH
          </span>
          <div
            style={{
              display: 'flex',
              border: '0.5px solid var(--color-border-secondary)',
              borderRadius: 'var(--border-radius-md)',
              overflow: 'hidden',
            }}
          >
            {['AND', 'OR'].map((c) => (
              <button
                key={c}
                disabled={disabled}
                onClick={() => setConnector(c)}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: connector === c ? 500 : 400,
                  background:
                    connector === c ? 'var(--color-text-primary)' : 'transparent',
                  color:
                    connector === c
                      ? 'var(--color-background-primary)'
                      : 'var(--color-text-secondary)',
                  border: 'none',
                  borderRadius: 0,
                  boxShadow: 'none',
                }}
              >
                {c === 'AND' ? 'all of' : 'any of'}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {connector === 'AND' ? 'every clause must match' : 'at least one clause must match'}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {clauses.map((c, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(150px, 1.4fr) 130px minmax(0, 1.4fr) 28px',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <select
              disabled={disabled}
              value={c.field}
              onChange={(e) => setClause(i, { field: e.target.value })}
              className="mono"
              style={{ fontSize: 11 }}
            >
              {knownVars.includes(c.field) ? null : (
                <option value={c.field}>{c.field}</option>
              )}
              {knownVars.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <select
              disabled={disabled}
              value={c.op}
              onChange={(e) => {
                const nextOp = e.target.value;
                // When the op switches to `in` / `not_in`, coerce the
                // value into an array if it isn't one yet — and back to
                // a scalar in the reverse direction.
                const wasList = c.op === 'in' || c.op === 'not_in';
                const willList = nextOp === 'in' || nextOp === 'not_in';
                let nextValue = c.value;
                if (!wasList && willList) {
                  nextValue = c.value == null || c.value === '' ? [] : [c.value];
                } else if (wasList && !willList) {
                  nextValue = Array.isArray(c.value) ? (c.value[0] ?? '') : c.value;
                }
                setClause(i, { op: nextOp, value: nextValue });
              }}
              style={{ fontSize: 11 }}
            >
              {OPS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <ValueInput
              field={c.field}
              op={c.op}
              value={c.value}
              disabled={disabled}
              onChange={(v) => setClause(i, { value: v })}
            />
            <button
              type="button"
              className="ghost icon-only"
              disabled={disabled || clauses.length === 1}
              onClick={() => removeClause(i)}
              title={clauses.length === 1 ? 'A rule needs at least one clause' : 'Remove this clause'}
            >
              <Ti name="x" size={12} />
            </button>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={addClause}
          style={{ fontSize: 11, padding: '4px 8px' }}
        >
          <Ti name="plus" size={12} /> Add clause
        </button>
      </div>
    </div>
  );
}

export { RuleBuilder, fromJsonLogic, toJsonLogic };
export default RuleBuilder;
