import { createPRNG } from "./prng";
import { sampleDistribution } from "./distributions";
import { buildEdgeGroups, executeDAGSample } from "./dag-executor";
import type {
  UncertaintyGraph,
  SimulationConfig,
  SimulationResult,
  SimulationBatch,
} from "@/lib/types";

/**
 * Sample all leaf nodes (nodes not targeted by any edge) for one iteration.
 */
function sampleLeafNodes(
  graph: UncertaintyGraph,
  rand: () => number
): Record<string, number> {
  const targets = new Set(graph.edges.map((e) => e.target));
  const samples: Record<string, number> = {};

  for (const node of graph.nodes) {
    // Sample ALL nodes — even intermediate targets get their base distribution sampled
    // The DAG executor will modify intermediate nodes via edges
    samples[node.id] = sampleDistribution(
      rand,
      node.distribution,
      node.mean,
      node.sd,
      node.range
    );
  }

  return samples;
}

/**
 * Run a full Monte Carlo simulation.
 * Returns all samples and statistics.
 */
export function runSimulation(
  graph: UncertaintyGraph,
  config: SimulationConfig
): SimulationResult {
  const seed = config.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rand = createPRNG(seed);
  const edgeGroups = buildEdgeGroups(graph);

  const allSamples: number[] = [];
  const nodeSamplesAll: Record<string, number[]> = {};

  for (const node of graph.nodes) {
    nodeSamplesAll[node.id] = [];
  }

  for (let i = 0; i < config.numSamples; i++) {
    const leafSamples = sampleLeafNodes(graph, rand);

    // Store per-node samples
    for (const node of graph.nodes) {
      nodeSamplesAll[node.id].push(leafSamples[node.id]);
    }

    const output = executeDAGSample(leafSamples, graph, edgeGroups);
    allSamples.push(output);
  }

  const sorted = [...allSamples].sort((a, b) => a - b);
  const mean = allSamples.reduce((s, v) => s + v, 0) / allSamples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const ciLow = sorted[Math.floor(sorted.length * 0.025)];
  const ciHigh = sorted[Math.floor(sorted.length * 0.975)];
  const threshold = graph.threshold ?? 0.5;
  const pAboveThreshold =
    allSamples.filter((s) => s > threshold).length / allSamples.length;

  return {
    samples: allSamples,
    mean,
    median,
    ciLow,
    ciHigh,
    pAboveThreshold,
    seed,
    nodeSamples: nodeSamplesAll,
  };
}

/**
 * Run simulation in batches, calling onBatch after each batch.
 * Used by the Web Worker for progressive streaming.
 */
export function runSimulationBatched(
  graph: UncertaintyGraph,
  config: SimulationConfig,
  onBatch: (batch: SimulationBatch) => void
): SimulationResult {
  const seed = config.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rand = createPRNG(seed);
  const edgeGroups = buildEdgeGroups(graph);

  const allSamples: number[] = [];
  const nodeSamplesAll: Record<string, number[]> = {};

  for (const node of graph.nodes) {
    nodeSamplesAll[node.id] = [];
  }

  const totalBatches = Math.ceil(config.numSamples / config.batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const batchStart = b * config.batchSize;
    const batchEnd = Math.min(batchStart + config.batchSize, config.numSamples);
    const batchSamples: number[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const leafSamples = sampleLeafNodes(graph, rand);

      for (const node of graph.nodes) {
        nodeSamplesAll[node.id].push(leafSamples[node.id]);
      }

      const output = executeDAGSample(leafSamples, graph, edgeGroups);
      allSamples.push(output);
      batchSamples.push(output);
    }

    // Compute running statistics
    const runningMean =
      allSamples.reduce((s, v) => s + v, 0) / allSamples.length;
    const runningSorted = [...allSamples].sort((a, b) => a - b);
    const runningCILow =
      runningSorted[Math.floor(runningSorted.length * 0.025)];
    const runningCIHigh =
      runningSorted[Math.floor(runningSorted.length * 0.975)];

    onBatch({
      batchIndex: b,
      samples: batchSamples,
      runningMean,
      runningCILow,
      runningCIHigh,
    });
  }

  const sorted = [...allSamples].sort((a, b) => a - b);
  const mean = allSamples.reduce((s, v) => s + v, 0) / allSamples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const ciLow = sorted[Math.floor(sorted.length * 0.025)];
  const ciHigh = sorted[Math.floor(sorted.length * 0.975)];
  const threshold = graph.threshold ?? 0.5;
  const pAboveThreshold =
    allSamples.filter((s) => s > threshold).length / allSamples.length;

  return {
    samples: allSamples,
    mean,
    median,
    ciLow,
    ciHigh,
    pAboveThreshold,
    seed,
    nodeSamples: nodeSamplesAll,
  };
}
