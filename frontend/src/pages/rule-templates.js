// Preset rule templates + JSON-Logic ↔ visual-clause round-trip helpers
// shared between the rule editor's Visual builder and the JSON pane.
//
// The visual builder handles the **flat** subset the UI exposes:
//   - one or more clauses, each `<var> <op> <literal>`
//   - operators ∈ ==, !=, >, >=, <, <=, in, not in
//   - clauses joined by a single connector (AND or OR)
// Anything else (nested `and/or`, `not`, computed operands) is treated
// as "too complex" — the builder switches to a banner that points the
// user back to the JSON tab.

/** UI operator → JSON-Logic op + optional negation flag. */
export const OPS = [
  { key: '==',     label: 'equals',          jl: '==', negate: false },
  { key: '!=',     label: 'is not',          jl: '!=', negate: false },
  { key: '>',      label: 'is greater than', jl: '>',  negate: false },
  { key: '>=',     label: 'is at least',     jl: '>=', negate: false },
  { key: '<',      label: 'is less than',    jl: '<',  negate: false },
  { key: '<=',     label: 'is at most',      jl: '<=', negate: false },
  { key: 'in',     label: 'is one of',       jl: 'in', negate: false },
  { key: 'not_in', label: 'is not one of',   jl: 'in', negate: true  },
];

const OP_BY_KEY = Object.fromEntries(OPS.map((o) => [o.key, o]));

const isComparisonOp = (op) => ['==', '!=', '>', '>=', '<', '<='].includes(op);

/**
 * Coerce a string input into the most likely literal type.
 * Numeric → number. true/false → boolean. Otherwise raw string.
 */
export function coerceLiteral(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Parse a comma-separated list into a literal array (typed per cell). */
export function coerceList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => coerceLiteral(s.trim()))
    .filter((v) => v !== '');
}

/**
 * Try to flatten a JSON-Logic expression into a sequence of
 * `{ field, op, value }` clauses joined by a single connector.
 * Returns `{ ok: true, connector, clauses }` on success or
 * `{ ok: false, reason }` when the shape exceeds what the visual
 * builder represents.
 */
export function fromJsonLogic(expr) {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) {
    return { ok: false, reason: 'Not an object' };
  }
  const op = Object.keys(expr)[0];
  const args = expr[op];

  // Single-clause shorthand: a bare comparison without a wrapping and/or.
  if (op !== 'and' && op !== 'or' && op !== 'not') {
    const clause = clauseFromComparison(op, args, /* negated */ false);
    if (!clause.ok) return clause;
    return { ok: true, connector: 'AND', clauses: [clause.clause] };
  }

  // `not in [...]` — a single negated in-clause.
  if (op === 'not') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, reason: '`not` body must be an object' };
    }
    const innerOp = Object.keys(args)[0];
    if (innerOp !== 'in') {
      return { ok: false, reason: 'Only `not in` is supported in the visual builder' };
    }
    const clause = clauseFromComparison(innerOp, args[innerOp], /* negated */ true);
    if (!clause.ok) return clause;
    return { ok: true, connector: 'AND', clauses: [clause.clause] };
  }

  // and / or — every child must be a flat comparison (or `not in`).
  const connector = op === 'and' ? 'AND' : 'OR';
  const out = [];
  for (const child of args || []) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      return { ok: false, reason: 'Child clause is not an object' };
    }
    const childOp = Object.keys(child)[0];
    if (childOp === 'not') {
      const inner = child.not;
      if (!inner || Object.keys(inner)[0] !== 'in') {
        return { ok: false, reason: 'Nested `not` is only supported when negating `in`' };
      }
      const clause = clauseFromComparison('in', inner.in, true);
      if (!clause.ok) return clause;
      out.push(clause.clause);
      continue;
    }
    if (childOp === 'and' || childOp === 'or') {
      return { ok: false, reason: 'Nested and/or is too complex for the visual builder' };
    }
    const clause = clauseFromComparison(childOp, child[childOp], false);
    if (!clause.ok) return clause;
    out.push(clause.clause);
  }
  return { ok: true, connector, clauses: out };
}

function clauseFromComparison(op, args, negated) {
  if (!Array.isArray(args) || args.length !== 2) {
    return { ok: false, reason: `Operator \`${op}\` needs two operands` };
  }
  const [left, right] = args;
  if (!left || typeof left !== 'object' || Array.isArray(left) || left.var === undefined) {
    return { ok: false, reason: 'Left operand must be `{ var: "<field>" }`' };
  }
  if (op === 'in') {
    if (!Array.isArray(right)) {
      return { ok: false, reason: '`in` right operand must be a literal array' };
    }
    return {
      ok: true,
      clause: { field: left.var, op: negated ? 'not_in' : 'in', value: right },
    };
  }
  if (isComparisonOp(op)) {
    if (typeof right === 'object' && right !== null) {
      return { ok: false, reason: 'Right operand must be a literal, not an expression' };
    }
    return { ok: true, clause: { field: left.var, op, value: right } };
  }
  return { ok: false, reason: `Operator \`${op}\` isn't in the visual builder set` };
}

/**
 * Compile a `{ connector, clauses }` model back into JSON-Logic. A
 * single clause emits the bare comparison; multiple clauses wrap in
 * `and` / `or`. `in` clauses with `op: 'not_in'` are emitted as
 * `{ not: { in: [...] } }`.
 */
export function toJsonLogic({ connector, clauses }) {
  if (!Array.isArray(clauses) || clauses.length === 0) return null;
  const parts = clauses.map(clauseToJsonLogic).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { [connector === 'OR' ? 'or' : 'and']: parts };
}

function clauseToJsonLogic(c) {
  if (!c || !c.field) return null;
  if (c.op === 'in' || c.op === 'not_in') {
    const list = Array.isArray(c.value) ? c.value : [];
    const node = { in: [{ var: c.field }, list] };
    return c.op === 'not_in' ? { not: node } : node;
  }
  const op = OP_BY_KEY[c.op] || OP_BY_KEY['=='];
  return { [op.jl]: [{ var: c.field }, c.value] };
}

/**
 * Examples palette for the JSON pane. Each one is a complete rule
 * expression the user can drop into the editor with one click; the
 * "for" hints which side of the pipeline it's meant for so the UI can
 * tag the example with the matching stage.
 */
export const EXAMPLES = [
  {
    title: 'Receiver blocklist (mules)',
    for: 'PRE',
    action: 'DENY',
    description: 'Decline if the receiver is on a static mule list.',
    expression: {
      in: [{ var: 'receiver_id' }, ['acct_mule_a', 'acct_mule_b', 'acct_mule_c']],
    },
  },
  {
    title: 'Vendor allow-list',
    for: 'PRE',
    action: 'ALLOW',
    description: 'Skip ML for known vendor accounts.',
    expression: {
      in: [{ var: 'receiver_id' }, { var: 'config.vendor_ids' }],
    },
  },
  {
    title: 'High-value + new beneficiary',
    for: 'POST',
    action: 'DENY',
    description: 'Decline ≥₦200k transfers to a beneficiary the sender has never paid before.',
    expression: {
      and: [
        { '>=': [{ var: 'amount' }, 200000] },
        { '==': [{ var: 'features.beneficiary_first_send' }, true] },
      ],
    },
  },
  {
    title: 'Velocity spike',
    for: 'POST',
    action: 'REVIEW',
    description: 'Flag senders whose 24-hour velocity is more than 3 standard deviations above baseline.',
    expression: {
      '>': [{ var: 'features.velocity_zscore' }, 3.0],
    },
  },
  {
    title: 'Smurfing pattern',
    for: 'POST',
    action: 'REVIEW',
    description: 'Many small transfers in an hour — classic structuring signature.',
    expression: {
      and: [
        { '>=': [{ var: 'features.txns_1h_count' }, 6] },
        { '<': [{ var: 'amount' }, 100000] },
      ],
    },
  },
  {
    title: 'ML borderline review',
    for: 'POST',
    action: 'REVIEW',
    description: 'Send anything the ML model scored in the uncertain band to a human reviewer.',
    expression: {
      and: [
        { '>=': [{ var: 'ml_score' }, 0.55] },
        { '<': [{ var: 'ml_score' }, 0.78] },
      ],
    },
  },
  {
    title: 'VPN exit from foreign ASN',
    for: 'POST',
    action: 'REVIEW',
    description: 'Country of IP doesn\'t match sender country AND the connection is on a VPN.',
    expression: {
      and: [
        { '==': [{ var: 'features.ip_is_vpn' }, true] },
        { '!=': [{ var: 'features.ip_country' }, { var: 'features.sender_country' }] },
      ],
    },
  },
];
