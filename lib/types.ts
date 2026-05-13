// ============================================================
// finESS Core Type Definitions
// ============================================================

/** Distribution types supported by the Monte Carlo engine */
export type DistributionType = "beta" | "normal" | "uniform" | "lognormal";

/** How edges combine their source values into a target node */
export type CombinationMethod =
  | "additive"
  | "subtractive"
  | "bayesian_update"
  | "multiplicative"
  | "custom";

/** A single uncertainty node in the graph */
export interface UncertaintyNode {
  id: string;
  name: string;
  description: string;
  distribution: DistributionType;
  mean: number;
  sd: number;
  range: [number, number];
  unit: string;
  /** Which group this node belongs to for DAG composition */
  group?: string;
}

/**
 * A directed edge in the uncertainty graph.
 * Each edge carries its own combination method — no monolithic computeFn.
 */
export interface ReasoningEdge {
  id: string;
  source: string;
  target: string;
  method: CombinationMethod;
  /** Optional label for narration */
  label?: string;
}

/**
 * The complete uncertainty graph — nodes + edges.
 * NO computeFn field. The DAG executor walks edges by method.
 */
export interface UncertaintyGraph {
  nodes: UncertaintyNode[];
  edges: ReasoningEdge[];
  /** The node ID that produces the final output */
  outputNodeId: string;
  /** Decision threshold (e.g., 0.30 for PE) */
  threshold?: number;
  /** AI-generated narration explaining the reasoning */
  narration?: string;
}

/** Configuration for a simulation run */
export interface SimulationConfig {
  numSamples: number;
  batchSize: number;
  /** Optional seed for reproducibility. If omitted, a random seed is generated and saved. */
  seed?: number;
}

/** Per-sample batch streamed from worker */
export interface SimulationBatch {
  batchIndex: number;
  samples: number[];
  runningMean: number;
  runningCILow: number;
  runningCIHigh: number;
}

/** Final result of a completed simulation */
export interface SimulationResult {
  samples: number[];
  mean: number;
  median: number;
  ciLow: number;
  ciHigh: number;
  pAboveThreshold: number;
  /** The seed used — always saved for reproducibility */
  seed: number;
  /** Per-node sample arrays for spectrum bars */
  nodeSamples: Record<string, number[]>;
}

/**
 * Sensitivity analysis result for a single node.
 * Both methods are always computed:
 * - varianceReduction: "fix to mean" (v0.2) — what % of output variance does this node cause?
 * - ciWidthReduction: "halve SD" (v0.1) — how much would better information shrink the CI?
 */
export interface SensitivityResult {
  nodeId: string;
  nodeName: string;
  /** % of output variance attributable to this node (fix-to-mean method) */
  varianceReduction: number;
  /** % reduction in CI width if this node's SD were halved */
  ciWidthReduction: number;
}

/** Worker message types */
export type WorkerMessage =
  | { type: "start"; graph: UncertaintyGraph; config: SimulationConfig }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "batch"; batch: SimulationBatch }
  | { type: "complete"; result: SimulationResult; sensitivity: SensitivityResult[] }
  | { type: "error"; message: string };

/** Simulation phase for UI state management */
export type SimulationPhase = "idle" | "running" | "complete" | "error";

/** Saved analysis for persistence */
export interface SavedAnalysis {
  id: string;
  query: string;
  graph: UncertaintyGraph;
  result: SimulationResult;
  sensitivity: SensitivityResult[];
  createdAt: string;
}

/** A real-world outcome for calibration tracking */
export interface CalibrationOutcome {
  id: string;
  analysisId: string;
  predictedProbability: number;
  actualOutcome: boolean;
  recordedAt: string;
}
