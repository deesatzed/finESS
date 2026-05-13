import { normalFromUniform } from "./prng";
import type { DistributionType } from "@/lib/types";

/**
 * Compute beta distribution alpha/beta from mean and SD.
 * Matches Python reference: distribclin_expert_system2.py:94-98
 */
export function getBetaParams(
  mean: number,
  sd: number
): { alpha: number; beta: number } {
  const variance = sd * sd;
  const alpha = mean * (mean * (1 - mean) / variance - 1);
  const beta = (1 - mean) * (mean * (1 - mean) / variance - 1);
  return {
    alpha: Math.max(alpha, 0.05),
    beta: Math.max(beta, 0.05),
  };
}

/**
 * Sample from a beta distribution using the Jöhnk algorithm.
 * Handles a wide range of alpha/beta values.
 */
function sampleBeta(rand: () => number, alpha: number, beta: number): number {
  // Use the gamma method for general alpha/beta
  const gammaA = sampleGamma(rand, alpha);
  const gammaB = sampleGamma(rand, beta);
  return gammaA / (gammaA + gammaB);
}

/**
 * Sample from a gamma distribution using Marsaglia & Tsang's method.
 */
function sampleGamma(rand: () => number, shape: number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(rand, shape + 1) * Math.pow(rand(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;
    do {
      x = normalFromUniform(rand, 0, 1);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Sample a single value from a distribution.
 * Clips to [range[0], range[1]] for all distribution types.
 */
export function sampleDistribution(
  rand: () => number,
  dist: DistributionType,
  mean: number,
  sd: number,
  range: [number, number]
): number {
  let value: number;

  switch (dist) {
    case "beta": {
      const { alpha, beta } = getBetaParams(mean, sd);
      value = sampleBeta(rand, alpha, beta);
      break;
    }
    case "normal": {
      value = normalFromUniform(rand, mean, sd);
      break;
    }
    case "uniform": {
      value = range[0] + rand() * (range[1] - range[0]);
      break;
    }
    case "lognormal": {
      const sigma2 = Math.log(1 + (sd * sd) / (mean * mean));
      const mu = Math.log(mean) - sigma2 / 2;
      value = Math.exp(normalFromUniform(rand, mu, Math.sqrt(sigma2)));
      break;
    }
    default:
      throw new Error(`Unknown distribution type: ${dist}`);
  }

  return Math.max(range[0], Math.min(range[1], value));
}
