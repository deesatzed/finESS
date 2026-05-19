import { normalFromUniform } from "./prng";
import type { DistributionType, UncertaintyNode } from "@/lib/types";

/**
 * Inverse-CDF sample from a Triangular(min, mode, max) distribution.
 * Reference: hometier-app2.html line 2491 (original design).
 * Caller is responsible for validating min <= mode <= max.
 */
export function sampleTriangular(
  rand: () => number,
  min: number,
  mode: number,
  max: number
): number {
  if (max === min) return min;
  const u = rand();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

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
    case "triangular": {
      // Triangular uses range[0]/range[1] as min/max with mode at (min+max)/2.
      // Callers that have a non-symmetric mode should use sampleNode(rand, node)
      // instead, which reads node.min/mode/max as the authoritative source.
      const min = range[0];
      const max = range[1];
      const symmetricMode = (min + max) / 2;
      value = sampleTriangular(rand, min, symmetricMode, max);
      break;
    }
    default:
      throw new Error(`Unknown distribution type: ${dist}`);
  }

  return Math.max(range[0], Math.min(range[1], value));
}

/**
 * Sample the node's distribution without applying any gate.
 */
function sampleNodeRaw(rand: () => number, node: UncertaintyNode): number {
  if (node.distribution === "triangular") {
    if (
      typeof node.min !== "number" ||
      typeof node.mode !== "number" ||
      typeof node.max !== "number"
    ) {
      throw new Error(
        `Node '${node.id}' is triangular but is missing min/mode/max`
      );
    }
    if (!(node.min <= node.mode && node.mode <= node.max)) {
      throw new Error(
        `Node '${node.id}' triangular params invalid: require min <= mode <= max, got min=${node.min} mode=${node.mode} max=${node.max}`
      );
    }
    const v = sampleTriangular(rand, node.min, node.mode, node.max);
    return Math.max(node.min, Math.min(node.max, v));
  }
  return sampleDistribution(
    rand,
    node.distribution,
    node.mean,
    node.sd,
    node.range
  );
}

/**
 * Node-aware sampler that knows how to read distribution-specific fields
 * (min/mode/max for triangular) and applies an optional Bernoulli mixture
 * gate (C2). Engine callers should prefer this over the primitive
 * sampleDistribution because it lets each distribution use the fields that
 * genuinely parameterize it.
 *
 * When `node.gate` is set, the node fires with probability `gate.probability`
 * (sampled normally) and otherwise returns `gate.inactiveValue` (default 0).
 * The gate is checked BEFORE consuming a sample from the underlying
 * distribution, so PRNG consumption is intentionally not held constant
 * across firing/non-firing iterations — gated nodes are stochastic in both
 * dimensions (whether they fire, and what value they take if they fire).
 */
export function sampleNode(rand: () => number, node: UncertaintyNode): number {
  if (node.gate !== undefined) {
    const p = node.gate.probability;
    if (typeof p !== "number" || p < 0 || p > 1) {
      throw new Error(
        `Node '${node.id}' has invalid gate.probability '${p}' (must be in [0, 1])`
      );
    }
    if (p === 0) {
      return node.gate.inactiveValue ?? 0;
    }
    if (p === 1) {
      return sampleNodeRaw(rand, node);
    }
    if (rand() < p) {
      return sampleNodeRaw(rand, node);
    }
    return node.gate.inactiveValue ?? 0;
  }
  return sampleNodeRaw(rand, node);
}
