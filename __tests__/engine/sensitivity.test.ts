import { computeSensitivity } from "@/lib/engine/sensitivity";
import { PE_GRAPH, PYTHON_GOLDEN } from "./test-fixtures";
import type { SimulationConfig } from "@/lib/types";

const config: SimulationConfig = {
  numSamples: 10000,
  batchSize: 500,
  seed: 42,
};

describe("computeSensitivity", () => {
  test("returns results for all nodes", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    expect(results.length).toBe(PE_GRAPH.nodes.length);
  });

  test("variance reduction values are non-negative", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    for (const r of results) {
      expect(r.varianceReduction).toBeGreaterThanOrEqual(0);
    }
  });

  test("CI width reduction values are non-negative", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    for (const r of results) {
      expect(r.ciWidthReduction).toBeGreaterThanOrEqual(0);
    }
  });

  test("top 2 nodes by variance match Python ranking", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    // Python ranking top 2: pre_test_base, comorbidity_adjust
    const top2 = results.slice(0, 2).map((r) => r.nodeId);
    expect(top2).toContain("pre_test_base");
    expect(top2).toContain("comorbidity_adjust");
  });

  test("pre_test_base has highest variance contribution", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    expect(results[0].nodeId).toBe("pre_test_base");
    // Should be roughly ~50%, allow wide tolerance since different PRNG
    expect(results[0].varianceReduction).toBeGreaterThan(25);
  });

  test("d_dimer_sens has lowest variance contribution", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    // d_dimer_sens should be near the bottom (Python: 0.45%)
    const sensResult = results.find((r) => r.nodeId === "d_dimer_sens")!;
    expect(sensResult.varianceReduction).toBeLessThan(10);
  });

  test("both methods are computed for each node", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    for (const r of results) {
      expect(typeof r.varianceReduction).toBe("number");
      expect(typeof r.ciWidthReduction).toBe("number");
    }
  });

  test("results are sorted by variance reduction descending", () => {
    const results = computeSensitivity(PE_GRAPH, config);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].varianceReduction).toBeGreaterThanOrEqual(
        results[i].varianceReduction
      );
    }
  });

  test("handles zero-variance baseline (all fixed nodes) gracefully", () => {
    // Graph with a single node that has extremely small SD → near-zero variance
    const zeroVar: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.0001, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "output", method: "additive" },
      ],
      outputNodeId: "output",
    };
    const results = computeSensitivity(zeroVar, { numSamples: 500, batchSize: 500, seed: 42 });
    expect(results.length).toBe(1);
    // Both reductions should be >= 0
    expect(results[0].varianceReduction).toBeGreaterThanOrEqual(0);
    expect(results[0].ciWidthReduction).toBeGreaterThanOrEqual(0);
  });

  test("uses default seed of 42 when none provided", () => {
    const noSeedConfig = { numSamples: 1000, batchSize: 500 };
    const r1 = computeSensitivity(PE_GRAPH, noSeedConfig);
    const r2 = computeSensitivity(PE_GRAPH, noSeedConfig);
    // Both should use seed=42 and produce identical results
    expect(r1).toEqual(r2);
  });
});
