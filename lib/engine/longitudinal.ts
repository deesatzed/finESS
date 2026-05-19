import { createPRNG } from "./prng";
import { sampleNode } from "./distributions";
import { buildEdgeGroups, executeDAGSample } from "./dag-executor";
import { applyTransition } from "./recurrence";
import type {
  LongitudinalGraph,
  LongitudinalResult,
  SimulationConfig,
  UncertaintyGraph,
} from "@/lib/types";

/**
 * Longitudinal Monte Carlo sampler (C3a).
 *
 * Extends the single-shot DAG path in `monte-carlo.ts` with state
 * carryover across `horizonSteps` inner steps per Monte Carlo sample.
 * Each step:
 *   1. Samples every node fresh (independent of prior step's samples).
 *   2. Applies the typed-AST recurrence against a snapshot of the
 *      previous-step state to compute the next state.
 *   3. Records the new state into per-step accumulators.
 *
 * After all samples we compute, for each state variable and each step
 * index 0..horizonSteps, the running mean and 95% empirical CI
 * (2.5 / 97.5 percentile) across samples. The parent SimulationResult
 * fields are computed from the FINAL-step value of the headline
 * variable (`outputStateVar` if set, else DAG output of `outputNodeId`).
 *
 * Seed propagation matches `monte-carlo.runSimulation` exactly for
 * symmetry: `config.seed ?? Math.floor(Math.random() * 2**32)`, then
 * `createPRNG(seed)`, and the chosen seed is saved on the result.
 */

/**
 * Sample every node in the graph using its declared distribution.
 * Routes through sampleNode so triangular nodes (C1) read their
 * min/mode/max correctly and Bernoulli-gated nodes (C2) honour their
 * firing probability inside the longitudinal loop.
 */
function sampleAllNodes(
  graph: UncertaintyGraph,
  rand: () => number
): Record<string, number> {
  const samples: Record<string, number> = {};
  for (const node of graph.nodes) {
    samples[node.id] = sampleNode(rand, node);
  }
  return samples;
}

/**
 * Validate longitudinal-specific inputs that the engine guards against
 * regardless of upstream validation. Throws on:
 *   - non-integer / non-positive horizonSteps
 *   - missing stateTransition
 *   - outputStateVar declared but not present in initialState
 *
 * Reference validation (unknown node ids / unknown state vars inside
 * recurrence expressions) is enforced lazily by the evaluator so we
 * don't need to walk the AST here.
 */
function validateLongitudinalGraph(graph: LongitudinalGraph): void {
  if (!Number.isInteger(graph.horizonSteps) || graph.horizonSteps <= 0) {
    throw new Error(
      `LongitudinalGraph.horizonSteps must be a positive integer; got ${graph.horizonSteps}`
    );
  }
  if (!graph.stateTransition) {
    throw new Error("LongitudinalGraph.stateTransition is required");
  }
  if (
    graph.outputStateVar !== undefined &&
    !Object.prototype.hasOwnProperty.call(
      graph.stateTransition.initialState,
      graph.outputStateVar
    )
  ) {
    throw new Error(
      `LongitudinalGraph.outputStateVar "${graph.outputStateVar}" is not present in initialState`
    );
  }
}

/**
 * Compute the 2.5 / 97.5 percentile and mean of an array. The percentile
 * indexing matches monte-carlo.ts so longitudinal and single-shot CIs
 * are computed identically.
 */
function summarize(values: number[]): { mean: number; ciLow: number; ciHigh: number } {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const ciLow = sorted[Math.floor(n * 0.025)];
  const ciHigh = sorted[Math.floor(n * 0.975)];
  return { mean, ciLow, ciHigh };
}

/**
 * Run a longitudinal Monte Carlo simulation.
 *
 * Total leaf samples drawn = numSamples × horizonSteps × graph.nodes.length.
 * Plan upstream callers accordingly — a 10k × 30-step run is 300k
 * inner iterations, which is comfortable for in-browser execution but
 * worth flagging to users.
 */
export function runLongitudinalSimulation(
  graph: LongitudinalGraph,
  config: SimulationConfig
): LongitudinalResult {
  validateLongitudinalGraph(graph);

  const seed = config.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rand = createPRNG(seed);
  const edgeGroups = buildEdgeGroups(graph);

  const horizon = graph.horizonSteps;
  const stateVarNames = Object.keys(graph.stateTransition.initialState);

  // pathSeries[varName][stepIndex] = array of per-sample state values at that step.
  // Step index 0 is the initialState (replicated across all samples for symmetry).
  const pathSeries: Record<string, number[][]> = {};
  for (const v of stateVarNames) {
    pathSeries[v] = Array.from({ length: horizon + 1 }, () => [] as number[]);
  }

  // Headline samples: final-step value of outputStateVar OR DAG output.
  const headlineSamples: number[] = [];

  // Per-node samples across ALL inner iterations (numSamples × horizonSteps).
  // Mirrors monte-carlo.ts's `nodeSamples` field on SimulationResult so
  // downstream sensitivity / spectrum code can still introspect node
  // distributions even when a longitudinal graph is in play.
  const nodeSamplesAll: Record<string, number[]> = {};
  for (const node of graph.nodes) {
    nodeSamplesAll[node.id] = [];
  }

  for (let i = 0; i < config.numSamples; i++) {
    // Start each sample at the same initialState.
    let state: Record<string, number> = { ...graph.stateTransition.initialState };
    for (const v of stateVarNames) {
      pathSeries[v][0].push(state[v]);
    }

    // Track the last DAG output of this sample (only used when
    // outputStateVar is unset, so we avoid the cost when we can).
    let lastDagOutput = 0;
    const computeDag = graph.outputStateVar === undefined;

    for (let step = 1; step <= horizon; step++) {
      const samples = sampleAllNodes(graph, rand);
      for (const node of graph.nodes) {
        nodeSamplesAll[node.id].push(samples[node.id]);
      }

      if (computeDag) {
        // Only required for the headline if the caller did not pick a
        // state variable. The DAG output is computed per step but we
        // only retain the final one.
        lastDagOutput = executeDAGSample(samples, graph, edgeGroups);
      }

      state = applyTransition(graph.stateTransition.recurrence, state, samples);

      for (const v of stateVarNames) {
        // If the recurrence introduced a new variable not in initialState,
        // it would not have an entry in pathSeries — we deliberately ignore
        // such variables for path traces. The applyTransition contract
        // says variables not in updates carry through; new variables are
        // a misuse and would be caught by a future C3b validator.
        if (Object.prototype.hasOwnProperty.call(pathSeries, v)) {
          pathSeries[v][step].push(state[v] ?? graph.stateTransition.initialState[v]);
        }
      }
    }

    const headline =
      graph.outputStateVar !== undefined
        ? state[graph.outputStateVar]
        : lastDagOutput;
    headlineSamples.push(headline);
  }

  // Reduce pathSeries → pathTraces with per-step summary statistics.
  const pathTraces: LongitudinalResult["pathTraces"] = {};
  for (const v of stateVarNames) {
    const perStepMean: number[] = new Array(horizon + 1);
    const perStepCiLow: number[] = new Array(horizon + 1);
    const perStepCiHigh: number[] = new Array(horizon + 1);
    for (let step = 0; step <= horizon; step++) {
      const { mean, ciLow, ciHigh } = summarize(pathSeries[v][step]);
      perStepMean[step] = mean;
      perStepCiLow[step] = ciLow;
      perStepCiHigh[step] = ciHigh;
    }
    pathTraces[v] = { perStepMean, perStepCiLow, perStepCiHigh };
  }

  // Headline statistics across the final-step samples.
  const sortedHeadline = [...headlineSamples].sort((a, b) => a - b);
  const headlineMean =
    headlineSamples.reduce((s, v) => s + v, 0) / headlineSamples.length;
  const headlineMedian = sortedHeadline[Math.floor(sortedHeadline.length / 2)];
  const headlineCiLow = sortedHeadline[Math.floor(sortedHeadline.length * 0.025)];
  const headlineCiHigh = sortedHeadline[Math.floor(sortedHeadline.length * 0.975)];
  const threshold = graph.threshold ?? 0.5;
  const pAboveThreshold =
    headlineSamples.filter((s) => s > threshold).length / headlineSamples.length;

  return {
    samples: headlineSamples,
    mean: headlineMean,
    median: headlineMedian,
    ciLow: headlineCiLow,
    ciHigh: headlineCiHigh,
    pAboveThreshold,
    seed,
    nodeSamples: nodeSamplesAll,
    pathTraces,
    horizonSteps: horizon,
  };
}
