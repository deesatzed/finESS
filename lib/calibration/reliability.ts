/**
 * C5a: reliability-diagram bin computation for calibration outcomes.
 *
 * "Calibration is the metric" (DistribClin Principle 4): a forecast that
 * says 30% should actually happen 30% of the time. This module bins
 * predicted probabilities by 0-decile, 1-decile, ..., 9-decile (default 10
 * bins) and reports the mean predicted probability and the empirical
 * observed frequency in each bin. The UI in C5b plots these against the
 * y=x perfect-calibration line.
 *
 * EMPTY-BIN POLICY (Principle 6: "a wide interval is useful honesty"):
 * bins with zero outcomes are returned with `count: 0` so the diagram can
 * render the absence transparently. No synthetic fill, no nearest-neighbor
 * smoothing. An honest gap is more useful than a misleading curve.
 *
 * INSUFFICIENT-DATA POLICY: `isReliable` is true only when total >= 20
 * outcomes. Below that, callers should render an empty-state message
 * rather than the diagram. The 20-outcome threshold matches the existing
 * Calibration UI gate; see `lib/ui/analysis-status.ts`.
 *
 * Pure function. No I/O, no side effects.
 */

import type { CalibrationOutcome } from "@/lib/types";

export interface ReliabilityBin {
  /** Inclusive lower edge of the bin (0..1). */
  lowerBin: number;
  /** Exclusive upper edge, except the last bin which is inclusive (0..1]. */
  upperBin: number;
  /** Number of outcomes in this bin. Zero is preserved verbatim. */
  count: number;
  /** Mean of `predictedProbability` across outcomes in this bin; NaN when count===0. */
  predictedMean: number;
  /** Fraction of outcomes in this bin where actualOutcome===true; NaN when count===0. */
  observedFrequency: number;
}

export interface ReliabilityReport {
  bins: ReliabilityBin[];
  totalCount: number;
  /** True iff totalCount >= MIN_OUTCOMES_FOR_RELIABILITY. */
  isReliable: boolean;
}

/**
 * Below this many outcomes, the diagram is too noisy to be informative.
 * Callers should show an empty-state message ("calibration requires >= 20;
 * current: N") rather than rendering a misleading sparse diagram.
 */
export const MIN_OUTCOMES_FOR_RELIABILITY = 20;

/**
 * Compute reliability bins for an outcome set.
 *
 * @param outcomes — every recorded outcome with predictedProbability in [0,1]
 *                   and actualOutcome boolean.
 * @param binCount — number of equally-sized bins on [0, 1]. Default 10.
 *                   Must be a positive integer; throws otherwise.
 */
export function computeReliability(
  outcomes: CalibrationOutcome[],
  binCount = 10
): ReliabilityReport {
  if (!Number.isInteger(binCount) || binCount <= 0) {
    throw new Error(
      `binCount must be a positive integer, got ${binCount}`
    );
  }

  // Initialize empty bins so every bin is represented even with zero data.
  const bins: Array<{
    lowerBin: number;
    upperBin: number;
    count: number;
    predSum: number;
    obsSum: number;
  }> = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      lowerBin: i / binCount,
      upperBin: (i + 1) / binCount,
      count: 0,
      predSum: 0,
      obsSum: 0,
    });
  }

  for (const o of outcomes) {
    const p = o.predictedProbability;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      // Silently skip malformed outcomes; the validators at write-time
      // already reject these, so this branch is defensive.
      continue;
    }
    // Bin index: floor(p * binCount), clamp the right edge so p===1 lands
    // in the last bin (not an out-of-range bin index).
    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = bins[idx];
    bin.count += 1;
    bin.predSum += p;
    bin.obsSum += o.actualOutcome ? 1 : 0;
  }

  const totalCount = bins.reduce((acc, b) => acc + b.count, 0);

  return {
    bins: bins.map((b) => ({
      lowerBin: b.lowerBin,
      upperBin: b.upperBin,
      count: b.count,
      predictedMean: b.count > 0 ? b.predSum / b.count : NaN,
      observedFrequency: b.count > 0 ? b.obsSum / b.count : NaN,
    })),
    totalCount,
    isReliable: totalCount >= MIN_OUTCOMES_FOR_RELIABILITY,
  };
}
