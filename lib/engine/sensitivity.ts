import { createPRNG } from "./prng";
import { sampleDistribution, sampleNode } from "./distributions";
import { buildEdgeGroups, executeDAGSample } from "./dag-executor";
import type {
  UncertaintyGraph,
  SimulationConfig,
  SensitivityResult,
} from "@/lib/types";

/**
 * Compute sensitivity analysis using BOTH methods:
 *
 * 1. "Fix to mean" (v0.2 method): Fix each node to its mean, rerun MC.
 *    Measures what % of output variance is attributable to that node.
 *    Used for variance contribution radar.
 *
 * 2. "Halve SD" (v0.1 method): Halve each node's SD, rerun MC.
 *    Measures how much the CI width would shrink with better information.
 *    Used for information value / tornado chart.
 */
export function computeSensitivity(
  graph: UncertaintyGraph,
  config: SimulationConfig
): SensitivityResult[] {
  const seed = config.seed ?? 42;
  const edgeGroups = buildEdgeGroups(graph);

  // First: compute baseline
  const baselineResult = runWithOverrides(graph, config, seed, edgeGroups, {});
  const baseVariance = variance(baselineResult);
  const baseCIWidth = ciWidth(baselineResult);

  const results: SensitivityResult[] = [];

  for (const node of graph.nodes) {
    // Method 1: Fix to mean
    const fixedResult = runWithOverrides(graph, config, seed, edgeGroups, {
      [node.id]: { fixedValue: node.mean },
    });
    const fixedVariance = variance(fixedResult);
    const varianceReduction =
      baseVariance > 0
        ? Math.max(0, ((baseVariance - fixedVariance) / baseVariance) * 100)
        : 0;

    // Method 2: Halve SD
    const halvedResult = runWithOverrides(graph, config, seed, edgeGroups, {
      [node.id]: { sdMultiplier: 0.5 },
    });
    const halvedCIWidth = ciWidth(halvedResult);
    const ciWidthReduction =
      baseCIWidth > 0
        ? Math.max(0, ((baseCIWidth - halvedCIWidth) / baseCIWidth) * 100)
        : 0;

    results.push({
      nodeId: node.id,
      nodeName: node.name,
      varianceReduction,
      ciWidthReduction,
    });
  }

  // Sort by variance reduction (primary metric)
  results.sort((a, b) => b.varianceReduction - a.varianceReduction);

  return results;
}

interface NodeOverride {
  fixedValue?: number;
  sdMultiplier?: number;
}

function runWithOverrides(
  graph: UncertaintyGraph,
  config: SimulationConfig,
  seed: number,
  edgeGroups: ReturnType<typeof buildEdgeGroups>,
  overrides: Record<string, NodeOverride>
): number[] {
  const rand = createPRNG(seed);
  const samples: number[] = [];

  for (let i = 0; i < config.numSamples; i++) {
    const nodeSamples: Record<string, number> = {};

    for (const node of graph.nodes) {
      const override = overrides[node.id];
      if (override?.fixedValue !== undefined) {
        nodeSamples[node.id] = override.fixedValue;
      } else if (override?.sdMultiplier !== undefined) {
        // SD perturbation path: well-defined for normal/beta/lognormal.
        // Triangular has no SD parameter — sampleDistribution's triangular
        // fallback uses [range[0], range[1]] with symmetric mode here,
        // which is honest about not supporting SD perturbation for triangular.
        const sd = node.sd * override.sdMultiplier;
        nodeSamples[node.id] = sampleDistribution(
          rand,
          node.distribution,
          node.mean,
          sd,
          node.range
        );
      } else {
        // No perturbation: use the node-aware sampler so triangular nodes
        // read their min/mode/max correctly.
        nodeSamples[node.id] = sampleNode(rand, node);
      }
    }

    samples.push(executeDAGSample(nodeSamples, graph, edgeGroups));
  }

  return samples;
}

function variance(samples: number[]): number {
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return (
    samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length
  );
}

function ciWidth(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.025)];
  const high = sorted[Math.floor(sorted.length * 0.975)];
  return high - low;
}
