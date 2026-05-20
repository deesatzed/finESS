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
 * A single piece of supporting evidence behind a `ResearchBundle`.
 * Phase B (commit batch landing the mechanism modules) standardised on
 * a single open shape that accommodates every mechanism without forcing
 * a discriminated union — the alternative was five parallel types and
 * a validator that had to branch per mechanism. Every field except
 * `source` is optional; mechanisms populate what they have.
 *
 * Per-mechanism conventions (informational; the validator does not
 * enforce these so future mechanisms can extend freely):
 *
 *  - llm_prior:           { source }                       (citation name)
 *  - web_search:          { url, title?, snippet }         (Tavily snippet + URL)
 *  - rag_document:        { documentId, chunkId, chunkText, sourceFilename }
 *  - multi_llm_consensus: { source }  (source = "model:<id>", snippet = per-model reasoning)
 *  - ensemble_forecast:   { source, snippet }              (source = "ensemble-model:<name>")
 *  - empirical_observation: { source, snippet }            (source = "csv:<column>")
 *  - expert_panel:        { source, snippet }              (source = label or "expert-N")
 *
 * The validator enforces:
 *  - citations is an array (when present at all)
 *  - every entry is an object
 *  - every entry has at least one of `source`, `url`, or `documentId`
 *    (else the citation carries no identifying information)
 *  - any present field is the right type
 *
 * Unknown extra fields are preserved verbatim (open shape).
 */
export interface ResearchCitation {
  /** Generic citation source identifier — typically used by llm_prior, expert_panel, consensus, forecast, empirical mechanisms. */
  source?: string;
  /** Web-search citations: the URL of the supporting page. */
  url?: string;
  /** Web-search citations: page title, when the provider returned one. */
  title?: string;
  /** Free-text snippet supporting the claim (web search, expert panel, etc.). */
  snippet?: string;
  /** RAG citations: the SemanticDocument row id. */
  documentId?: string;
  /** RAG citations: the chunk index within the document. */
  chunkId?: string | number;
  /** RAG citations: the actual chunk text used in the prompt. */
  chunkText?: string;
  /** RAG citations: human-readable source filename for UI display. */
  sourceFilename?: string;
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
  /**
   * Per-mechanism supporting evidence. Optional in the type because
   * legacy bundles (before Phase B) and the simplest hand-typed bundles
   * may omit it; mechanisms produced in Phase B always populate it.
   */
  citations?: ResearchCitation[];
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
