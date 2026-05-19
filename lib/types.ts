// ============================================================
// finESS Core Type Definitions
// ============================================================

/** Distribution types supported by the Monte Carlo engine */
export type DistributionType =
  | "beta"
  | "normal"
  | "uniform"
  | "lognormal"
  | "triangular";

/** How edges combine their source values into a target node */
export type CombinationMethod =
  | "additive"
  | "subtractive"
  | "bayesian_update"
  | "multiplicative";

/**
 * Provenance of a node's mean/SD estimates.
 * Used by UI colour-coding (M8-07) and ensembling/aggregation logic
 * (R6-07) to weight nodes differently based on epistemic source.
 *
 * - "literature": values cited from published research (sourceNote should hold the citation)
 * - "llm_prior":  values produced by the LLM as a prior estimate (default when unspecified)
 * - "user_override": values supplied or edited by the human user via the UI
 */
export type NodeSource = "literature" | "llm_prior" | "user_override";

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
  /**
   * Where this node's estimates came from. Optional in the type to keep
   * pre-existing fixture and persistence shapes valid; consumers should
   * treat `undefined` as `"llm_prior"`. Normalized boundary functions
   * (parseAIResponse, NodeEditor save handler) always populate this field
   * so downstream code can rely on it being set in live graphs.
   */
  source?: NodeSource;
  /** Optional one-line citation or note describing the source. */
  sourceNote?: string;
  /**
   * Triangular distribution parameters. Used only when `distribution === "triangular"`.
   * Must satisfy `min <= mode <= max`. When triangular is selected, `mean` and `sd`
   * are derived from these (mean = (min+mode+max)/3) and `range` is ignored as the
   * authoritative bounds; min/max are the source of truth.
   */
  min?: number;
  mode?: number;
  max?: number;
  /**
   * Bernoulli mixture gate (C2). When set, this node fires on each Monte Carlo
   * iteration with `probability` p; on the (1-p) fraction it contributes
   * `inactiveValue` (default 0) instead of a sampled value. Composes with any
   * `distribution` — e.g. "major home repair surprise" is Lognormal(14500, 9800)
   * gated at p=0.12. The original hometier-app2.html used this pattern for
   * episodic events.
   */
  gate?: {
    probability: number;
    inactiveValue?: number;
  };
  /**
   * Operator-assigned impact tag (C4). First-class metadata in the original
   * hometier design ("impact: 'critical'" on disability cost when applicable).
   * Used by the UI to surface high-impact nodes prominently, and cross-
   * referenced by sensitivity analysis to flag discrepancies between operator
   * judgment ("I flagged this critical") and engine output ("but variance
   * attribution says it only drives N% of the output spread").
   */
  impact?: "low" | "medium" | "high" | "critical";
}

/** Allowed values for UncertaintyNode.impact (C4). */
export const VALID_IMPACTS = ["low", "medium", "high", "critical"] as const;
export type NodeImpact = (typeof VALID_IMPACTS)[number];

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
  /** Whether the graph represents simulation assumptions or observed data. */
  analysisMode?: "simulation" | "observed";
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
