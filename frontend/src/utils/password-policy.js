// Mirror of src/shared/authz/password-policy.ts — same rules, same
// score, same labels. Kept duplicated rather than imported across the
// frontend/backend Vite/TS boundary; if the policy changes, update
// both files. The backend re-evaluates on every change-password call
// so the client cannot weaken the rule.

export const MIN_LENGTH = 12;
export const MIN_SCORE = 3;

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'administrator',
  'root',
  'changeme',
  'iloveyou',
  'monkey',
  'dragon',
  'sentinel',
  'sentinel1',
  'fraudit',
  'admin@fraudit',
]);

export const SCORE_LABELS = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
};

export const SCORE_TONE = {
  0: 'danger',
  1: 'danger',
  2: 'warn',
  3: 'success',
  4: 'success',
};

export function evaluatePassword(password, context = {}) {
  const pw = password ?? '';
  const username = (context.username || '').toLowerCase();
  const lc = pw.toLowerCase();

  const checks = {
    length: pw.length >= MIN_LENGTH,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    symbol: /[^A-Za-z0-9]/.test(pw),
    notUsername: username ? !lc.includes(username) && username.length > 0 : true,
    notCommon: !COMMON.has(lc) && ![...COMMON].some((c) => c.length > 4 && lc.includes(c)),
  };

  const issues = [];
  if (!checks.length) issues.push(`Use at least ${MIN_LENGTH} characters`);
  if (!checks.upper) issues.push('Include an uppercase letter');
  if (!checks.lower) issues.push('Include a lowercase letter');
  if (!checks.digit) issues.push('Include a digit');
  if (!checks.symbol) issues.push('Include a symbol');
  if (!checks.notUsername) issues.push("Don't include your username");
  if (!checks.notCommon) issues.push('Avoid common or breached passwords');
  if (context.currentPassword && context.currentPassword === pw) {
    issues.push('Differ from your current password');
  }

  let score = 0;
  if (checks.length) {
    let s = 0;
    if (checks.upper) s++;
    if (checks.lower) s++;
    if (checks.digit) s++;
    if (checks.symbol) s++;
    if (pw.length >= 16) s = Math.min(4, s + 1);
    if (!checks.notCommon || !checks.notUsername) s = Math.max(0, s - 2);
    score = Math.max(0, Math.min(4, s));
  }

  const ok =
    issues.length === 0 &&
    score >= MIN_SCORE &&
    Object.values(checks).every(Boolean);

  return { ok, score, issues, checks };
}

/** Map a checks key to a user-friendly label for the checklist. */
export const CHECK_LABELS = {
  length: `At least ${MIN_LENGTH} characters`,
  upper: 'Uppercase letter (A–Z)',
  lower: 'Lowercase letter (a–z)',
  digit: 'A digit (0–9)',
  symbol: 'A symbol (! @ # …)',
  notUsername: 'Does not contain your username',
  notCommon: 'Not a common / breached password',
};
