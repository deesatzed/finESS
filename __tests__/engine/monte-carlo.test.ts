import { runSimulation, runSimulationBatched } from "@/lib/engine/monte-carlo";
import { PE_GRAPH, PYTHON_GOLDEN } from "./test-fixtures";
import type { SimulationConfig } from "@/lib/types";

const config: SimulationConfig = {
  numSamples: 15000,
  batchSize: 500,
  seed: 42,
};

describe("runSimulation", () => {
  test("produces deterministic results with same seed", () => {
    const r1 = runSimulation(PE_GRAPH, config);
    const r2 = runSimulation(PE_GRAPH, config);
    expect(r1.mean).toBe(r2.mean);
    expect(r1.ciLow).toBe(r2.ciLow);
    expect(r1.ciHigh).toBe(r2.ciHigh);
    expect(r1.samples).toEqual(r2.samples);
  });

  test("saves the seed used", () => {
    const result = runSimulation(PE_GRAPH, config);
    expect(result.seed).toBe(42);
  });

  test("generates a random seed when none provided", () => {
    const noSeed: SimulationConfig = { numSamples: 100, batchSize: 100 };
    const r1 = runSimulation(PE_GRAPH, noSeed);
    const r2 = runSimulation(PE_GRAPH, noSeed);
    expect(r1.seed).toBeDefined();
    expect(r2.seed).toBeDefined();
    // Extremely unlikely to be the same
    expect(r1.seed).not.toBe(r2.seed);
  });

  test("mean is in reasonable range vs Python golden reference", () => {
    const result = runSimulation(PE_GRAPH, config);
    // Different PRNG, so allow 10% tolerance on the mean
    expect(result.mean).toBeGreaterThan(PYTHON_GOLDEN.mean * 0.75);
    expect(result.mean).toBeLessThan(PYTHON_GOLDEN.mean * 1.25);
  });

  test("CI width is in reasonable range vs Python golden reference", () => {
    const result = runSimulation(PE_GRAPH, config);
    const ciWidth = result.ciHigh - result.ciLow;
    expect(ciWidth).toBeGreaterThan(PYTHON_GOLDEN.ciWidth * 0.5);
    expect(ciWidth).toBeLessThan(PYTHON_GOLDEN.ciWidth * 1.5);
  });

  test("produces correct number of samples", () => {
    const result = runSimulation(PE_GRAPH, config);
    expect(result.samples.length).toBe(15000);
  });

  test("all samples are in [0, 1]", () => {
    const result = runSimulation(PE_GRAPH, config);
    for (const s of result.samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("per-node samples are populated", () => {
    const result = runSimulation(PE_GRAPH, config);
    for (const node of PE_GRAPH.nodes) {
      expect(result.nodeSamples[node.id]).toBeDefined();
      expect(result.nodeSamples[node.id].length).toBe(15000);
    }
  });
});

describe("runSimulationBatched", () => {
  test("streams correct number of batches", () => {
    const batches: number[] = [];
    runSimulationBatched(PE_GRAPH, config, (batch) => {
      batches.push(batch.batchIndex);
    });
    expect(batches.length).toBe(Math.ceil(15000 / 500));
  });

  test("produces same result as non-batched with same seed", () => {
    const unbatched = runSimulation(PE_GRAPH, config);
    const batched = runSimulationBatched(PE_GRAPH, config, () => {});
    expect(batched.mean).toBe(unbatched.mean);
    expect(batched.samples).toEqual(unbatched.samples);
  });

  test("running statistics converge", () => {
    const means: number[] = [];
    runSimulationBatched(PE_GRAPH, config, (batch) => {
      means.push(batch.runningMean);
    });
    // Later means should be closer to each other (convergence)
    const last5 = means.slice(-5);
    const range = Math.max(...last5) - Math.min(...last5);
    expect(range).toBeLessThan(0.01);
  });
});
