/**
 * C5a: Brier score for calibration outcomes.
 *
 * Standard formula: mean((predicted - actual)^2) where `actual` is 0/1.
 * Range [0, 1]; lower is better; 0 is perfect.
 *
 * Decomposition (reliability - resolution + uncertainty) is intentionally
 * NOT computed here — the reliability diagram already surfaces calibration
 * shape, and decomposition adds interpretation surface area without obvious
 * UI benefit today. Can be added later if the UI needs it.
 *
 * Pure function. No I/O, no side effects.
 */

import type { CalibrationOutcome } from "@/lib/types";

export interface BrierResult {
  /** The Brier score itself. NaN when there are zero usable outcomes. */
  score: number;
  /** Number of outcomes that contributed to the score (after filtering). */
  count: number;
}

export function computeBrierScore(outcomes: CalibrationOutcome[]): BrierResult {
  let sum = 0;
  let count = 0;
  for (const o of outcomes) {
    const p = o.predictedProbability;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      continue;
    }
    const actual = o.actualOutcome ? 1 : 0;
    const diff = p - actual;
    sum += diff * diff;
    count += 1;
  }
  return {
    score: count > 0 ? sum / count : NaN,
    count,
  };
}
