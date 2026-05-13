import { createPRNG, normalFromUniform } from "@/lib/engine/prng";

describe("Mulberry32 PRNG", () => {
  test("produces deterministic output for same seed", () => {
    const r1 = createPRNG(42);
    const r2 = createPRNG(42);
    const seq1 = Array.from({ length: 100 }, () => r1());
    const seq2 = Array.from({ length: 100 }, () => r2());
    expect(seq1).toEqual(seq2);
  });

  test("produces different output for different seeds", () => {
    const r1 = createPRNG(42);
    const r2 = createPRNG(43);
    const v1 = r1();
    const v2 = r2();
    expect(v1).not.toEqual(v2);
  });

  test("output is in [0, 1)", () => {
    const rand = createPRNG(42);
    for (let i = 0; i < 10000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("output is approximately uniform (chi-squared rough check)", () => {
    const rand = createPRNG(12345);
    const bins = new Array(10).fill(0);
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const bin = Math.min(9, Math.floor(rand() * 10));
      bins[bin]++;
    }
    const expected = n / 10;
    for (const count of bins) {
      // Each bin should be within 15% of expected
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });
});

describe("normalFromUniform (Box-Muller)", () => {
  test("produces values with correct mean and SD", () => {
    const rand = createPRNG(42);
    const n = 50000;
    const mean = 5;
    const sd = 2;
    const samples = Array.from({ length: n }, () =>
      normalFromUniform(rand, mean, sd)
    );
    const sampleMean = samples.reduce((a, b) => a + b, 0) / n;
    const sampleSD = Math.sqrt(
      samples.reduce((a, b) => a + (b - sampleMean) ** 2, 0) / (n - 1)
    );
    expect(sampleMean).toBeCloseTo(mean, 1);
    expect(sampleSD).toBeCloseTo(sd, 1);
  });
});
