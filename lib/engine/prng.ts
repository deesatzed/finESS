/**
 * Mulberry32 seeded PRNG — deterministic, fast, good distribution.
 * Used for reproducible Monte Carlo results.
 */
export function createPRNG(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller transform: convert two uniform samples to a normal sample.
 */
export function normalFromUniform(
  rand: () => number,
  mean: number,
  sd: number
): number {
  const u1 = rand();
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z;
}
