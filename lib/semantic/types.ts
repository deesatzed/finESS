/**
 * Type skeletons for the semantic conversation surface (Phase A).
 *
 * These are intentionally minimal — A3 (clarify), A4 (propose-components),
 * and Phase B research mechanisms will extend them with their full payloads.
 * The state machine in `./state-machine.ts` uses these as opaque carriers so
 * its transition rules can be exercised independently of the LLM adapters.
 */

/** Research mechanisms recognized by Phase B. */
export type ResearchMechanism =
  | "llm_prior"
  | "web_search"
  | "rag_document"
  | "multi_llm_consensus"
  | "ensemble_forecast"
  | "empirical_observation"
  | "expert_panel";

/** Distributions supported by the engine (Phase C). */
export type SemanticDistribution =
  | "normal"
  | "beta"
  | "uniform"
  | "lognormal"
  | "triangular";

/**
 * A clarifying question posed by the LLM in the CLARIFYING phase.
 * A3 will flesh this out (defaultAnswer, why, suggested options).
 */
export interface ClarifyingQuestion {
  id: string;
  question: string;
  defaultAnswer?: string;
  why?: string;
}

/**
 * A component proposed by the LLM in PROPOSING_COMPONENTS.
 * A4 will extend with dependsOn, distribution suggestion, etc.
 */
export interface ProposedComponent {
  id: string;
  name: string;
  description: string;
  suggestedDistribution?: SemanticDistribution;
  dependsOn?: string[];
  why?: string;
}

/**
 * Patch shape for `editComponent` — fields the user can edit in the
 * REVIEWING_COMPONENTS step. All optional; merged shallow over the
 * existing component.
 */
export interface ComponentPatch {
  name?: string;
  description?: string;
  suggestedDistribution?: SemanticDistribution;
  dependsOn?: string[];
  why?: string;
}

/**
 * Distribution parameters returned by a research mechanism. The exact
 * fields depend on `distribution`; consumers (Phase B) validate the
 * pairing. Kept loose here so any distribution shape can ride through.
 */
export interface ProposedParams {
  mean?: number;
  sd?: number;
  min?: number;
  max?: number;
  mode?: number;
  alpha?: number;
  beta?: number;
}

/**
 * Result of a single research pass on one component. Phase B fills in
 * `citations`, `perModelProposals`, `expertEstimates`, etc. based on
 * `mechanism`.
 */
export interface ResearchBundle {
  componentId: string;
  mechanism: ResearchMechanism;
  proposedDistribution: SemanticDistribution;
  proposedParams: ProposedParams;
  reasoning: string;
}

/**
 * Result of the engine run in the MODELING phase. Phase A5 / cockpit
 * handoff reads this; the full type lives in `lib/engine`.
 */
export interface ModelRunResult {
  /** Component id with the highest sensitivity contribution. */
  topSensitivityComponentId?: string;
  /** Probability the output exceeds the chosen threshold. */
  pAboveThreshold?: number;
  /** Opaque blob of engine output. The state machine does not introspect it. */
  raw?: unknown;
}
