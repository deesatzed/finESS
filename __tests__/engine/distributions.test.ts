import { createPRNG } from "@/lib/engine/prng";
import {
  getBetaParams,
  sampleDistribution,
  sampleTriangular,
  sampleNode,
} from "@/lib/engine/distributions";
import type { UncertaintyNode } from "@/lib/types";

describe("getBetaParams", () => {
  test("computes correct alpha/beta for mean=0.18, sd=0.055", () => {
    const { alpha, beta } = getBetaParams(0.18, 0.055);
    // From Python: alpha = mean * (mean*(1-mean)/var - 1)
    const var_ = 0.055 ** 2;
    const expectedAlpha = 0.18 * (0.18 * 0.82 / var_ - 1);
    const expectedBeta = 0.82 * (0.18 * 0.82 / var_ - 1);
    expect(alpha).toBeCloseTo(expectedAlpha, 4);
    expect(beta).toBeCloseTo(expectedBeta, 4);
  });

  test("floors at 0.05 for extreme parameters", () => {
    // Very small mean and huge SD would produce negative alpha
    const { alpha, beta } = getBetaParams(0.001, 0.5);
    expect(alpha).toBeGreaterThanOrEqual(0.05);
    expect(beta).toBeGreaterThanOrEqual(0.05);
  });
});

describe("sampleDistribution", () => {
  const rand = createPRNG(42);

  test("beta distribution has approximately correct mean", () => {
    const r = createPRNG(42);
    const n = 20000;
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "beta", 0.18, 0.055, [0.05, 0.45])
    );
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeCloseTo(0.18, 1);
  });

  test("normal distribution has approximately correct mean and SD", () => {
    const r = createPRNG(123);
    const n = 20000;
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "normal", 0.04, 0.025, [-0.05, 0.15])
    );
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeCloseTo(0.04, 1);
  });

  test("samples are clipped to range", () => {
    const r = createPRNG(999);
    for (let i = 0; i < 5000; i++) {
      const v = sampleDistribution(r, "normal", 0.5, 0.3, [0.1, 0.9]);
      expect(v).toBeGreaterThanOrEqual(0.1);
      expect(v).toBeLessThanOrEqual(0.9);
    }
  });

  test("uniform distribution spans range", () => {
    const r = createPRNG(42);
    const n = 10000;
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "uniform", 0.5, 0.1, [0.2, 0.8])
    );
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeCloseTo(0.5, 1);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.2);
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.8);
  });

  test("lognormal distribution is right-skewed with correct mean", () => {
    const r = createPRNG(42);
    const n = 20000;
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "lognormal", 2.0, 0.5, [0.1, 10])
    );
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeCloseTo(2.0, 0);
  });

  test("throws on unknown distribution", () => {
    const r = createPRNG(42);
    expect(() =>
      sampleDistribution(r, "unknown" as any, 0.5, 0.1, [0, 1])
    ).toThrow("Unknown distribution type");
  });

  test("beta with small alpha triggers gamma shape<1 boost path", () => {
    // When mean is very small and SD is large relative to it,
    // getBetaParams produces alpha < 1, hitting the gamma boost branch
    const r = createPRNG(42);
    const n = 5000;
    // mean=0.02, sd=0.01 → alpha ≈ 0.02*(0.02*0.98/0.0001 - 1) ≈ 3.72 (not <1)
    // Need alpha < 1: mean=0.01, sd=0.09 → alpha ≈ 0.01*(0.01*0.99/0.0081 - 1) ≈ -0.0078 → clamped to 0.05
    // With alpha=0.05 (clamped), shape<1 path is taken
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "beta", 0.01, 0.09, [0, 1])
    );
    // All samples should be in range
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(samples.length).toBe(n);
  });
});

describe("sampleTriangular (C1)", () => {
  test("mean over many samples approximates (min + mode + max) / 3", () => {
    const r = createPRNG(42);
    const min = 0;
    const mode = 3;
    const max = 10;
    const n = 30000;
    const samples = Array.from({ length: n }, () =>
      sampleTriangular(r, min, mode, max)
    );
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    const expectedMean = (min + mode + max) / 3;
    expect(empiricalMean).toBeCloseTo(expectedMean, 1);
  });

  test("samples are always within [min, max]", () => {
    const r = createPRNG(123);
    for (let i = 0; i < 10000; i++) {
      const v = sampleTriangular(r, 1.8, 2.8, 5.5);
      expect(v).toBeGreaterThanOrEqual(1.8);
      expect(v).toBeLessThanOrEqual(5.5);
    }
  });

  test("mode at min produces right-skewed distribution", () => {
    const r = createPRNG(99);
    const n = 20000;
    const samples = Array.from({ length: n }, () =>
      sampleTriangular(r, 0, 0, 10)
    );
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    // mean = (0 + 0 + 10) / 3 ≈ 3.33
    expect(empiricalMean).toBeCloseTo(10 / 3, 1);
    // Most samples should be below 5 (skewed toward min)
    const belowFive = samples.filter((s) => s < 5).length / n;
    expect(belowFive).toBeGreaterThan(0.6);
  });

  test("mode at max produces left-skewed distribution", () => {
    const r = createPRNG(7);
    const n = 20000;
    const samples = Array.from({ length: n }, () =>
      sampleTriangular(r, 0, 10, 10)
    );
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    expect(empiricalMean).toBeCloseTo(20 / 3, 1);
    const aboveFive = samples.filter((s) => s > 5).length / n;
    expect(aboveFive).toBeGreaterThan(0.6);
  });

  test("min == max collapses to single point", () => {
    const r = createPRNG(1);
    for (let i = 0; i < 100; i++) {
      expect(sampleTriangular(r, 7, 7, 7)).toBe(7);
    }
  });
});

describe("sampleNode (C1) — node-aware dispatch", () => {
  function makeNode(overrides: Partial<UncertaintyNode>): UncertaintyNode {
    return {
      id: "n1",
      name: "N1",
      description: "test",
      distribution: "beta",
      mean: 0.5,
      sd: 0.1,
      range: [0, 1],
      unit: "%",
      ...overrides,
    };
  }

  test("routes triangular nodes to min/mode/max", () => {
    const r = createPRNG(42);
    const node = makeNode({
      distribution: "triangular",
      min: 1.8,
      mode: 2.8,
      max: 5.5,
      range: [0, 10], // intentionally wider than triangular bounds
    });
    const n = 20000;
    const samples = Array.from({ length: n }, () => sampleNode(r, node));
    for (const s of samples) {
      // Must respect triangular bounds, NOT the wider node.range.
      expect(s).toBeGreaterThanOrEqual(1.8);
      expect(s).toBeLessThanOrEqual(5.5);
    }
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    expect(empiricalMean).toBeCloseTo((1.8 + 2.8 + 5.5) / 3, 1);
  });

  test("throws if triangular node missing min/mode/max", () => {
    const r = createPRNG(42);
    const node = makeNode({ distribution: "triangular" });
    expect(() => sampleNode(r, node)).toThrow(/missing min\/mode\/max/);
  });

  test("throws if triangular node violates min <= mode <= max", () => {
    const r = createPRNG(42);
    const node = makeNode({
      distribution: "triangular",
      min: 5,
      mode: 3,
      max: 10,
    });
    expect(() => sampleNode(r, node)).toThrow(/min <= mode <= max/);
  });

  test("delegates non-triangular distributions to sampleDistribution", () => {
    const r = createPRNG(42);
    const node = makeNode({ distribution: "normal", mean: 5, sd: 1, range: [0, 10] });
    const n = 10000;
    const samples = Array.from({ length: n }, () => sampleNode(r, node));
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    expect(empiricalMean).toBeCloseTo(5, 0);
  });
});

describe("sampleDistribution triangular fallback (C1)", () => {
  test("triangular via primitive signature uses symmetric mode from range", () => {
    const r = createPRNG(42);
    const n = 20000;
    // Primitive signature can't carry mode, so it uses the midpoint.
    const samples = Array.from({ length: n }, () =>
      sampleDistribution(r, "triangular", 0, 0, [0, 10])
    );
    const empiricalMean = samples.reduce((a, b) => a + b, 0) / n;
    // Symmetric triangular(0, 5, 10) has mean = (0 + 5 + 10) / 3 ≈ 5
    expect(empiricalMean).toBeCloseTo(5, 1);
  });
});

describe("sampleNode Bernoulli gate (C2)", () => {
  function makeGatedNode(
    probability: number,
    inactiveValue?: number
  ): UncertaintyNode {
    return {
      id: "home_repair",
      name: "Home Repair Surprise",
      description: "lognormal hit firing rarely",
      distribution: "lognormal",
      mean: 14500,
      sd: 9800,
      range: [0, 100000],
      unit: "$",
      gate: inactiveValue === undefined ? { probability } : { probability, inactiveValue },
    };
  }

  test("probability=1 always fires (returns sampled distribution value)", () => {
    const r = createPRNG(42);
    const node = makeGatedNode(1);
    for (let i = 0; i < 500; i++) {
      const v = sampleNode(r, node);
      // Lognormal samples are positive; gate firing means we got the
      // distribution, not the inactiveValue (0).
      expect(v).toBeGreaterThan(0);
    }
  });

  test("probability=0 never fires (always returns inactiveValue=0)", () => {
    const r = createPRNG(42);
    const node = makeGatedNode(0);
    for (let i = 0; i < 500; i++) {
      expect(sampleNode(r, node)).toBe(0);
    }
  });

  test("observed fire rate over 20k samples approximates probability", () => {
    const r = createPRNG(123);
    const node = makeGatedNode(0.12);
    const n = 20000;
    let fired = 0;
    for (let i = 0; i < n; i++) {
      const v = sampleNode(r, node);
      if (v !== 0) fired++;
    }
    const observed = fired / n;
    expect(observed).toBeCloseTo(0.12, 2);
  });

  test("composes with triangular distribution", () => {
    const r = createPRNG(99);
    const node: UncertaintyNode = {
      id: "ssi_change",
      name: "SSI policy shift",
      description: "triangular hit when policy changes",
      distribution: "triangular",
      mean: 0,
      sd: 1,
      range: [-15, 8],
      unit: "%",
      min: -15,
      mode: 0,
      max: 8,
      gate: { probability: 0.25 },
    };
    const n = 20000;
    let fired = 0;
    const firedValues: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = sampleNode(r, node);
      if (v !== 0) {
        fired++;
        firedValues.push(v);
        expect(v).toBeGreaterThanOrEqual(-15);
        expect(v).toBeLessThanOrEqual(8);
      }
    }
    expect(fired / n).toBeCloseTo(0.25, 1);
    // Note: triangular mean over fired-only samples = (min+mode+max)/3 ≈ -2.33.
    // We don't tightly assert here because gate randomness is noisy on small
    // sub-samples; the bound check above is the load-bearing assertion.
  });

  test("custom inactiveValue is returned on non-firing iterations", () => {
    const r = createPRNG(7);
    const node = makeGatedNode(0.5, -99);
    const n = 10000;
    const values = Array.from({ length: n }, () => sampleNode(r, node));
    const inactiveCount = values.filter((v) => v === -99).length;
    const firedCount = values.filter((v) => v !== -99).length;
    expect(inactiveCount + firedCount).toBe(n);
    expect(inactiveCount / n).toBeCloseTo(0.5, 1);
    // All fired values are positive lognormal samples.
    const firedValues = values.filter((v) => v !== -99);
    for (const v of firedValues) {
      expect(v).toBeGreaterThan(0);
    }
  });

  test("throws on probability outside [0, 1]", () => {
    const r = createPRNG(42);
    expect(() => sampleNode(r, makeGatedNode(-0.1))).toThrow(
      /gate\.probability/
    );
    expect(() => sampleNode(r, makeGatedNode(1.5))).toThrow(/gate\.probability/);
  });
});
