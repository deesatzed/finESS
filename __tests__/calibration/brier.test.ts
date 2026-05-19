import { computeBrierScore } from "@/lib/calibration/brier";
import type { CalibrationOutcome } from "@/lib/types";

function makeOutcome(
  predictedProbability: number,
  actualOutcome: boolean
): CalibrationOutcome {
  return {
    id: `o-${Math.random()}`,
    analysisId: "a1",
    predictedProbability,
    actualOutcome,
    recordedAt: new Date().toISOString(),
  };
}

describe("computeBrierScore (C5a)", () => {
  test("returns NaN with count=0 on empty input", () => {
    const r = computeBrierScore([]);
    expect(r.score).toBeNaN();
    expect(r.count).toBe(0);
  });

  test("perfect calibration (always predicts the actual outcome) scores 0", () => {
    const outcomes = [
      makeOutcome(1, true),
      makeOutcome(0, false),
      makeOutcome(1, true),
    ];
    const r = computeBrierScore(outcomes);
    expect(r.score).toBe(0);
    expect(r.count).toBe(3);
  });

  test("worst calibration (always predicts opposite) scores 1", () => {
    const outcomes = [
      makeOutcome(0, true),
      makeOutcome(1, false),
    ];
    const r = computeBrierScore(outcomes);
    expect(r.score).toBe(1);
    expect(r.count).toBe(2);
  });

  test("predicting 0.5 every time scores 0.25 regardless of outcomes", () => {
    const outcomes = [
      makeOutcome(0.5, true),
      makeOutcome(0.5, false),
      makeOutcome(0.5, true),
      makeOutcome(0.5, false),
    ];
    const r = computeBrierScore(outcomes);
    expect(r.score).toBe(0.25);
  });

  test("canonical example (0.8, true), (0.3, false) → ((0.2)^2 + (0.3)^2) / 2 = 0.065", () => {
    const outcomes = [
      makeOutcome(0.8, true),
      makeOutcome(0.3, false),
    ];
    const r = computeBrierScore(outcomes);
    expect(r.score).toBeCloseTo(0.065, 6);
  });

  test("malformed outcomes (NaN, out-of-range) are skipped from both score and count", () => {
    const outcomes = [
      makeOutcome(0.5, true),
      makeOutcome(Number.NaN, true),
      makeOutcome(1.5, false),
    ];
    const r = computeBrierScore(outcomes);
    expect(r.count).toBe(1);
    expect(r.score).toBe(0.25);
  });
});
