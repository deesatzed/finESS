import {
  MIN_OUTCOMES_FOR_RELIABILITY,
  computeReliability,
} from "@/lib/calibration/reliability";
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

describe("computeReliability (C5a)", () => {
  test("empty input returns 10 empty bins with totalCount=0", () => {
    const r = computeReliability([]);
    expect(r.bins).toHaveLength(10);
    expect(r.totalCount).toBe(0);
    expect(r.isReliable).toBe(false);
    for (const bin of r.bins) {
      expect(bin.count).toBe(0);
      expect(bin.predictedMean).toBeNaN();
      expect(bin.observedFrequency).toBeNaN();
    }
  });

  test("perfectly-calibrated outcomes land predictedMean ≈ observedFrequency", () => {
    // For each decile bin, generate 20 outcomes where the observed rate
    // matches the bin's midpoint.
    const outcomes: CalibrationOutcome[] = [];
    for (let i = 0; i < 10; i++) {
      const mid = (i + 0.5) / 10;
      const trueCount = Math.round(20 * mid);
      for (let j = 0; j < 20; j++) {
        outcomes.push(makeOutcome(mid, j < trueCount));
      }
    }
    const r = computeReliability(outcomes);
    for (const bin of r.bins) {
      expect(bin.count).toBe(20);
      // Predicted mean is exactly the midpoint we used.
      expect(bin.predictedMean).toBeCloseTo((bin.lowerBin + bin.upperBin) / 2, 6);
      // Observed frequency is within rounding tolerance of the predicted.
      expect(bin.observedFrequency).toBeCloseTo(bin.predictedMean, 1);
    }
    expect(r.isReliable).toBe(true);
  });

  test("isReliable flips at exactly MIN_OUTCOMES_FOR_RELIABILITY", () => {
    const below = Array.from({ length: MIN_OUTCOMES_FOR_RELIABILITY - 1 }, () =>
      makeOutcome(0.5, true)
    );
    const at = Array.from({ length: MIN_OUTCOMES_FOR_RELIABILITY }, () =>
      makeOutcome(0.5, true)
    );
    expect(computeReliability(below).isReliable).toBe(false);
    expect(computeReliability(at).isReliable).toBe(true);
  });

  test("empty bins persist with count=0 and NaN means even when other bins have data", () => {
    // Outcomes only land in the [0.5, 0.6) bin.
    const outcomes = Array.from({ length: 30 }, () => makeOutcome(0.55, true));
    const r = computeReliability(outcomes);
    expect(r.totalCount).toBe(30);
    const middleBin = r.bins[5];
    expect(middleBin.count).toBe(30);
    expect(middleBin.predictedMean).toBeCloseTo(0.55, 6);
    expect(middleBin.observedFrequency).toBe(1);
    // Every other bin is genuinely empty.
    for (let i = 0; i < 10; i++) {
      if (i === 5) continue;
      expect(r.bins[i].count).toBe(0);
      expect(r.bins[i].predictedMean).toBeNaN();
      expect(r.bins[i].observedFrequency).toBeNaN();
    }
  });

  test("p=1 lands in the last bin (right edge inclusive)", () => {
    const r = computeReliability([makeOutcome(1, true)]);
    expect(r.bins[9].count).toBe(1);
    expect(r.bins[9].predictedMean).toBe(1);
  });

  test("p=0 lands in the first bin", () => {
    const r = computeReliability([makeOutcome(0, false)]);
    expect(r.bins[0].count).toBe(1);
    expect(r.bins[0].predictedMean).toBe(0);
    expect(r.bins[0].observedFrequency).toBe(0);
  });

  test("over-confident bins (predicted > observed) are visible in the report", () => {
    // 40 outcomes at p=0.9 but only 10 actually true → over-confident.
    const outcomes: CalibrationOutcome[] = [];
    for (let i = 0; i < 40; i++) {
      outcomes.push(makeOutcome(0.9, i < 10));
    }
    const r = computeReliability(outcomes);
    const lastBin = r.bins[9];
    expect(lastBin.count).toBe(40);
    expect(lastBin.predictedMean).toBeCloseTo(0.9, 6);
    expect(lastBin.observedFrequency).toBeCloseTo(0.25, 6);
    // The gap (0.9 - 0.25 = 0.65) is the reliability deficit the UI surfaces.
  });

  test("rejects non-positive or non-integer binCount", () => {
    expect(() => computeReliability([], 0)).toThrow(/positive integer/);
    expect(() => computeReliability([], -1)).toThrow(/positive integer/);
    expect(() => computeReliability([], 2.5)).toThrow(/positive integer/);
  });

  test("malformed outcomes (NaN, out-of-range) are silently skipped", () => {
    const outcomes = [
      makeOutcome(0.5, true),
      makeOutcome(Number.NaN, true),
      makeOutcome(1.5, true),
      makeOutcome(-0.1, true),
    ];
    const r = computeReliability(outcomes);
    // Only the well-formed 0.5 outcome should land.
    expect(r.totalCount).toBe(1);
  });

  test("respects custom binCount", () => {
    const outcomes = Array.from({ length: 50 }, (_, i) => makeOutcome(i / 50, true));
    const r = computeReliability(outcomes, 5);
    expect(r.bins).toHaveLength(5);
    expect(r.totalCount).toBe(50);
    // 10 outcomes per bin since indices 0..49 spread evenly across 5 bins.
    for (const bin of r.bins) expect(bin.count).toBe(10);
  });
});
