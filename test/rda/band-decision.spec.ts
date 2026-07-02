import { bandDecision } from "../../src/v1/modules/rda/utils/band-decision";
import { Decision } from "../../src/shared/enums/decision.enum";

describe("bandDecision", () => {
  it("keeps binary behaviour when the band is disabled", () => {
    expect(bandDecision(0.69, 0.7, null)).toBe(Decision.ACCEPT);
    expect(bandDecision(0.7, 0.7, null)).toBe(Decision.DECLINE);
  });

  it("routes the uncertainty band to REVIEW", () => {
    expect(bandDecision(0.54, 0.7, 0.55)).toBe(Decision.ACCEPT);
    expect(bandDecision(0.55, 0.7, 0.55)).toBe(Decision.REVIEW);
    expect(bandDecision(0.69, 0.7, 0.55)).toBe(Decision.REVIEW);
    expect(bandDecision(0.7, 0.7, 0.55)).toBe(Decision.DECLINE);
  });

  it("declines above threshold regardless of the band", () => {
    expect(bandDecision(0.99, 0.7, 0.55)).toBe(Decision.DECLINE);
  });
});
