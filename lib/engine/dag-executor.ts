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
 *
 * Invariant enforcement (R6-03): missing source values throw DAGExecutionError
 * rather than silently defaulting to 0 or 1. The pre-M8-01 parse path now
 * catches malformed graphs, but ensembled / programmatically-built graphs
 * (R6-07) bypass parse-time validation — the engine itself is the defensive
 * boundary against partial-garbage authoritative outputs.
 */

interface EdgeGroup {
  targetId: string;
  edges: { sourceId: string; method: CombinationMethod; edgeId: string }[];
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  "additive",
  "subtractive",
  "bayesian_update",
  "multiplicative",
]);

/**
 * Error codes for engine-level invariant violations.
 * Callers (notably monte-carlo.ts and any ensemble code path) can switch on
 * `.code` to distinguish recoverable structural problems from arithmetic bugs.
 */
export type DAGExecutionErrorCode =
  | "MISSING_SOURCE_VALUE"
  | "OUTPUT_NODE_UNSET";

export class DAGExecutionError extends Error {
  readonly code: DAGExecutionErrorCode;

  constructor(code: DAGExecutionErrorCode, message: string) {
    super(message);
    this.name = "DAGExecutionError";
    this.code = code;
    // Preserve prototype chain across transpilation targets that downlevel
    // class extension.
    Object.setPrototypeOf(this, DAGExecutionError.prototype);
  }
}

/**
 * Look up an edge-source value in the working samples map, throwing a
 * structured error if absent. Names the missing source AND the offending
 * edge so a debugger sees both ends of the broken wire.
 */
function requireSourceValue(
  values: Record<string, number>,
  sourceId: string,
  edgeId: string
): number {
  const v = values[sourceId];
  if (v === undefined || v === null || Number.isNaN(v)) {
    throw new DAGExecutionError(
      "MISSING_SOURCE_VALUE",
      `DAG execution: edge "${edgeId}" references source node "${sourceId}" which has no sampled value. ` +
        `This usually means the graph references a node that does not exist in graph.nodes, ` +
        `or an ensemble step merged edges with unknown source IDs.`
    );
  }
  return v;
}

/**
 * Build a topological ordering of edge groups.
 * Returns groups ordered so that dependencies are resolved first.
 */
export function buildEdgeGroups(graph: UncertaintyGraph): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();

  for (const edge of graph.edges) {
    if (!groups.has(edge.target)) {
      groups.set(edge.target, { targetId: edge.target, edges: [] });
    }
    groups.get(edge.target)!.edges.push({
      sourceId: edge.source,
      method: edge.method,
      edgeId: edge.id,
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
      const allSourcesResolved = group.edges.every((e: { sourceId: string; method: CombinationMethod; edgeId: string }) =>
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
 * @throws DAGExecutionError when a referenced source has no sampled value or
 *         when the output node is unset after walking all edges.
 */
export function executeDAGSample(
  nodeSamples: Record<string, number>,
  graph: UncertaintyGraph,
  edgeGroups: EdgeGroup[]
): number {
  // Work with a copy so we can add intermediate values
  const values = { ...nodeSamples };

  // Precompute the set of declared node IDs. Targets NOT in this set are
  // synthetic intermediates (e.g. "pre_test_composed", "output") that have
  // no sampled base — composing from 0 is mathematical truth there. Targets
  // that ARE declared nodes must have been sampled; absence is an invariant
  // violation.
  const declaredNodeIds = new Set(graph.nodes.map((n) => n.id));

  for (const group of edgeGroups) {
    const { targetId, edges } = group;

    // Determine the primary method for this group
    const methods = new Set(edges.map((e) => e.method));
    for (const method of methods) {
      if (!SUPPORTED_METHODS.has(method)) {
        throw new Error(`Unsupported edge method: ${method}`);
      }
    }

    if (methods.has("bayesian_update")) {
      // Bayesian update: needs pre-test, sensitivity, specificity
      // Collect additive sources as pre-test, the rest by role
      const bayesEdges = edges.filter((e) => e.method === "bayesian_update");
      const additiveEdges = edges.filter((e) => e.method === "additive");

      // If there are additive edges feeding into a bayesian target,
      // first compose them additively. Missing source = invariant violation.
      let preTest = 0;
      for (const e of additiveEdges) {
        preTest += requireSourceValue(values, e.sourceId, e.edgeId);
      }

      // Bayesian update sources should be: [pre_test, sensitivity, specificity]
      // The convention is: sources are ordered as they appear in edges.
      // Each bayesian source is a required operand; missing = invariant violation.
      const bayesSources = bayesEdges.map((e) =>
        requireSourceValue(values, e.sourceId, e.edgeId)
      );

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
        // Multiplicative operands are required; a silent ?? 1 would erase the
        // contribution of a broken edge while leaving the product looking sane.
        result *= requireSourceValue(values, e.sourceId, e.edgeId);
      }
      values[targetId] = result;
    } else if (methods.has("subtractive")) {
      // Subtractive: modify the target's existing value
      // If target already has a value (it's a declared node), use it as base.
      // Otherwise (synthetic intermediate, e.g. "output") base = 0 is the
      // documented "compose all sources" branch — mathematical truth.
      const subtractiveEdges = edges.filter((e) => e.method === "subtractive");
      const additiveEdges = edges.filter((e) => e.method === "additive");

      let base: number;
      if (declaredNodeIds.has(targetId)) {
        // Declared node — sampler should have populated it. Missing = invariant violation.
        const v = values[targetId];
        if (v === undefined || v === null || Number.isNaN(v)) {
          throw new DAGExecutionError(
            "MISSING_SOURCE_VALUE",
            `DAG execution: subtractive target "${targetId}" is a declared node but has no sampled value. ` +
              `Caller did not sample all nodes before invoking executeDAGSample.`
          );
        }
        base = v;
      } else {
        // Synthetic intermediate — start from 0 by definition.
        base = 0;
      }

      for (const e of additiveEdges) {
        base += requireSourceValue(values, e.sourceId, e.edgeId);
      }
      for (const e of subtractiveEdges) {
        base -= requireSourceValue(values, e.sourceId, e.edgeId);
      }
      values[targetId] = base;
    } else {
      // Default: additive composition. Sources are required operands.
      let sum = 0;
      for (const e of edges) {
        if (e.method === "additive") {
          sum += requireSourceValue(values, e.sourceId, e.edgeId);
        }
      }
      values[targetId] = sum;
    }
  }

  const out = values[graph.outputNodeId];
  if (out === undefined || out === null || Number.isNaN(out)) {
    throw new DAGExecutionError(
      "OUTPUT_NODE_UNSET",
      `DAG execution: output node "${graph.outputNodeId}" has no value after walking all edges. ` +
        `No edge group wrote to this target — the graph likely has no path reaching the declared output, ` +
        `or the output ID does not match any edge target.`
    );
  }
  return out;
}
