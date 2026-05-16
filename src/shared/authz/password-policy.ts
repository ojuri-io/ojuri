// Password strength policy shared by the change-password endpoint and
// (mirrored verbatim) the frontend `pages/change-password.jsx` live
// feedback. Single source of truth — when the rules change, update
// both files together (kept side-by-side for now; lifting to a single
// JS module that both transpile-paths can import is a separate task).
//
// Score range: 0 (very weak) … 4 (strong). The backend rejects
// anything below `MIN_SCORE`; the frontend renders a colour meter and
// gates the submit button on the same threshold.

export const MIN_LENGTH = 12;
export const MIN_SCORE = 3;

export type Strength = 0 | 1 | 2 | 3 | 4;

export interface PolicyResult {
  ok: boolean;
  score: Strength;
  issues: string[];
  /** Bools used by the frontend checklist UI. */
  checks: {
    length: boolean;
    upper: boolean;
    lower: boolean;
    digit: boolean;
    symbol: boolean;
    notUsername: boolean;
    notCommon: boolean;
  };
}

// Tiny built-in deny-list. Not a real breach corpus — just the
// obvious flags so we don't ship a "Password1!" demo. Adopters who
// need zxcvbn-grade scoring should swap this for the npm package.
const COMMON: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password123",
  "qwerty",
  "qwerty123",
  "letmein",
  "welcome",
  "welcome1",
  "admin",
  "admin123",
  "administrator",
  "root",
  "changeme",
  "iloveyou",
  "monkey",
  "dragon",
  "sentinel",
  "sentinel1",
  "fraudit",
  "admin@fraudit",
]);

export function evaluatePassword(
  password: string,
  context: { username?: string; currentPassword?: string } = {}
): PolicyResult {
  const pw = password ?? "";
  const username = (context.username || "").toLowerCase();
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

  const issues: string[] = [];
  if (!checks.length) issues.push(`Use at least ${MIN_LENGTH} characters`);
  if (!checks.upper) issues.push("Include an uppercase letter");
  if (!checks.lower) issues.push("Include a lowercase letter");
  if (!checks.digit) issues.push("Include a digit");
  if (!checks.symbol) issues.push("Include a symbol");
  if (!checks.notUsername) issues.push("Don't include your username");
  if (!checks.notCommon) issues.push("Avoid common or breached passwords");
  if (context.currentPassword && context.currentPassword === pw) {
    issues.push("Differ from your current password");
  }

  // Score: 1 point per character-class hit, +1 for ≥16 chars,
  // capped at 4. Length below MIN forces score=0 regardless.
  let score: Strength = 0;
  if (checks.length) {
    let s = 0;
    if (checks.upper) s++;
    if (checks.lower) s++;
    if (checks.digit) s++;
    if (checks.symbol) s++;
    if (pw.length >= 16) s = Math.min(4, s + 1);
    if (!checks.notCommon || !checks.notUsername) s = Math.max(0, s - 2);
    score = Math.max(0, Math.min(4, s)) as Strength;
  }

  return {
    ok:
      issues.length === 0 &&
      score >= MIN_SCORE &&
      Object.values(checks).every(Boolean),
    score,
    issues,
    checks,
  };
}

/** Human label for the meter. Frontend mirrors this list. */
export const SCORE_LABELS: Record<Strength, string> = {
  0: "Very weak",
  1: "Weak",
  2: "Fair",
  3: "Strong",
  4: "Very strong",
};
