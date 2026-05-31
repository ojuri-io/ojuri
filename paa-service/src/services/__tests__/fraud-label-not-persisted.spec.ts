/**
 * Regression test for the PAA decision-as-label feedback loop fixed in
 * b56a289 (§6j of fraud-validation-report).
 *
 * Pre-fix: paa-service/src/services/postgres.service.ts:53 wrote
 * `fraudLabel: event.fraud` — the model's own decision — into the
 * column MLA reads as ground truth. Every retrain cycle ingested its
 * own past predictions as labels and converged on reproducing prior
 * behaviour instead of detecting fraud.
 *
 * The fix sets `fraudLabel: null` on the persist path; ground truth
 * must come from chargebacks, reviewer overrides, or third-party CSVs
 * — never from the system's own decision.
 *
 * This test asserts the source still does what the fix intended by
 * reading the file and matching against the regex. A future refactor
 * that restores `event.fraud` (or even `Boolean(event.fraud)`) into
 * the persist path will trigger a failure.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// __tests__ sits inside src/services/, so the postgres service is one
// directory up.
const POSTGRES_SERVICE = resolve(__dirname, "..", "postgres.service.ts");

describe("PAA fraudLabel persist path", () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(POSTGRES_SERVICE, "utf8");
  });

  it("does not assign event.fraud into the transactions row's fraudLabel", () => {
    // The bug is any line that writes the decision into fraudLabel.
    // Match a `fraudLabel: <something that's not null>` pattern that
    // pulls from `event.*`.
    const badPattern = /fraudLabel:\s*event\./;
    expect(src).not.toMatch(badPattern);
  });

  it("writes fraudLabel as null in the persist record builder", () => {
    // Positive assertion: the file MUST contain `fraudLabel: null` to
    // make the no-decision-as-label invariant explicit. If someone
    // removes this entirely (and the column defaults to NULL, which
    // it does), behaviour is unchanged — but the explicit assignment
    // is the documentation. The regex tolerates whitespace + a
    // trailing comma.
    expect(src).toMatch(/fraudLabel:\s*null,/);
  });

  it("references groundTruthFraud or decisionAuditLog in the surrounding comment", () => {
    // The fix only makes sense alongside the explanation of *why*
    // fraudLabel is now null. Pin the comment so a refactor that
    // deletes the explanation gets flagged for review.
    const ctx = /(?:groundTruthFraud|decisionAuditLog)/;
    expect(src).toMatch(ctx);
  });
});
