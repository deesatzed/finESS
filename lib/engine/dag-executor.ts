import type { UncertaintyGraph, CombinationMethod } from "@/lib/types";

/**
 * DAG Executor: walks edges by method to compute the output node.
 *
 * Replaces monolithic computeFn dispatch. Each edge specifies its own method.
 *
 * Computation order (matching v0.2 PE pattern):
 * 1. Sample all leaf nodes
 * 2. Group edges by target
 * 3. For each intermediate target: compose inputs by edge method
 * 4. Final output node receives composed intermediates
 *
 * Example v0.2 PE flow:
 *   pre_test_base --additive--> [pre_test_composed]
 *   patient_modifier --additive--> [pre_test_composed]
 *   comorbidity_adjust --additive--> [pre_test_composed]
 *   lab_variability --subtractive--> d_dimer_spec (modifies spec)
 *   [pre_test_composed] + d_dimer_sens + d_dimer_spec --bayesian_update--> output
 */

interface EdgeGroup {
  targetId: string;
  edges: { sourceId: string; method: CombinationMethod }[];
}

/**
 * Build a topological ordering of edge groups.
 * Returns groups ordered so that dependencies are resolved first.
 */
export function buildEdgeGroups(graph: UncertaintyGraph): EdgeGroup[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const groups = new Map<string, EdgeGroup>();

  for (const edge of graph.edges) {
    if (!groups.has(edge.target)) {
      groups.set(edge.target, { targetId: edge.target, edges: [] });
    }
    groups.get(edge.target)!.edges.push({
      sourceId: edge.source,
      method: edge.method,
    });
  }

  // Topological sort: process groups whose sources are all leaf nodes first
  const sorted: EdgeGroup[] = [];
  const resolved = new Set<string>();

  // All leaf nodes (nodes that are not targets of any edge) are resolved
  const allTargets = new Set(graph.edges.map((e) => e.target));
  graph.nodes.forEach((n) => {
    if (!allTargets.has(n.id)) resolved.add(n.id);
  });

  const remainingKeys = Array.from(groups.keys());
  let iterations = 0;
  const maxIterations = remainingKeys.length + 1;

  while (remainingKeys.length > 0 && iterations < maxIterations) {
    iterations++;
    const toRemove: number[] = [];
    remainingKeys.forEach((targetId, idx) => {
      const group = groups.get(targetId)!;
      const allSourcesResolved = group.edges.every((e: { sourceId: string; method: CombinationMethod }) =>
        resolved.has(e.sourceId)
      );
      if (allSourcesResolved) {
        sorted.push(group);
        resolved.add(targetId);
        toRemove.push(idx);
      }
    });
    // Remove resolved in reverse order to preserve indices
    for (let i = toRemove.length - 1; i >= 0; i--) {
      remainingKeys.splice(toRemove[i], 1);
    }
  }

  if (remainingKeys.length > 0) {
    throw new Error("Cycle detected in uncertainty graph");
  }

  return sorted;
}

/**
 * Execute one Monte Carlo sample through the DAG.
 *
 * @param nodeSamples - Pre-sampled values for each leaf node
 * @param graph - The uncertainty graph
 * @param edgeGroups - Pre-computed edge groups (from buildEdgeGroups)
 * @returns The computed value for the output node
 */
export function executeDAGSample(
  nodeSamples: Record<string, number>,
  graph: UncertaintyGraph,
  edgeGroups: EdgeGroup[]
): number {
  // Work with a copy so we can add intermediate values
  const values = { ...nodeSamples };

  for (const group of edgeGroups) {
    const { targetId, edges } = group;

    // Determine the primary method for this group
    const methods = new Set(edges.map((e) => e.method));

    if (methods.has("bayesian_update")) {
      // Bayesian update: needs pre-test, sensitivity, specificity
      // Collect additive sources as pre-test, the rest by role
      const bayesEdges = edges.filter((e) => e.method === "bayesian_update");
      const additiveEdges = edges.filter((e) => e.method === "additive");

      // If there are additive edges feeding into a bayesian target,
      // first compose them additively
      let preTest = 0;
      for (const e of additiveEdges) {
        preTest += values[e.sourceId] ?? 0;
      }

      // Bayesian update sources should be: [pre_test, sensitivity, specificity]
      // The convention is: sources are ordered as they appear in edges
      const bayesSources = bayesEdges.map((e) => values[e.sourceId] ?? 0);

      if (bayesSources.length >= 2) {
        // First bayesian source = sensitivity, second = specificity
        // pre-test comes from additive composition or first bayesian source
        const pre = additiveEdges.length > 0 ? preTest : bayesSources[0];
        const sens =
          additiveEdges.length > 0 ? bayesSources[0] : bayesSources[1];
        const spec =
          additiveEdges.length > 0
            ? bayesSources[1]
            : bayesSources.length > 2
              ? bayesSources[2]
              : 0.5;

        const clampedPre = Math.max(0.01, Math.min(0.95, pre));
        const denom =
          clampedPre * sens + (1 - clampedPre) * (1 - spec);
        values[targetId] = (clampedPre * sens) / Math.max(denom, 1e-12);
        values[targetId] = Math.max(0, Math.min(1, values[targetId]));
      }
    } else if (methods.has("multiplicative")) {
      let result = 1;
      for (const e of edges) {
        result *= values[e.sourceId] ?? 1;
      }
      values[targetId] = result;
    } else if (methods.has("subtractive")) {
      // Subtractive: modify the target's existing value
      // If target already has a value (it's a real node), subtract from it
      // Otherwise compose all sources
      const subtractiveEdges = edges.filter((e) => e.method === "subtractive");
      const additiveEdges = edges.filter((e) => e.method === "additive");

      let base = values[targetId] ?? 0;
      for (const e of additiveEdges) {
        base += values[e.sourceId] ?? 0;
      }
      for (const e of subtractiveEdges) {
        base -= values[e.sourceId] ?? 0;
      }
      values[targetId] = base;
    } else {
      // Default: additive composition
      let sum = 0;
      for (const e of edges) {
        if (e.method === "additive") {
          sum += values[e.sourceId] ?? 0;
        }
      }
      values[targetId] = sum;
    }
  }

  return values[graph.outputNodeId] ?? 0;
}
