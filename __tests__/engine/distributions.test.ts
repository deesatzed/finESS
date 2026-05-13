import { createPRNG } from "@/lib/engine/prng";
import { getBetaParams, sampleDistribution } from "@/lib/engine/distributions";

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
});
