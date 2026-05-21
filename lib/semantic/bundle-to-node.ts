/**
 * D1 — bundle-to-node conversion.
 *
 * Converts a Phase B ResearchBundle + its matching ProposedComponent into a
 * fully-populated UncertaintyNode ready for the Monte Carlo engine. The
 * resulting node carries a NodeProvenance block so downstream consumers
 * (export, UI, audit) have access to the full citation chain without
 * re-querying the conversation state.
 *
 * Design constraints:
 *  - Zero I/O: pure synchronous transform. The caller owns API calls.
 *  - Additive only: does not touch any field on UncertaintyNode that the
 *    caller did not explicitly derive from the bundle.
 *  - Idempotent: calling twice with the same inputs produces identical output.
 */

import type { UncertaintyNode, NodeSource, NodeProvenance } from "@/lib/types";
import type { ResearchBundle, ProposedComponent } from "@/lib/semantic/types";

/** Mapping from ResearchMechanism literal to the NodeSource enum value. */
const MECHANISM_TO_NODE_SOURCE: Record<ResearchBundle["mechanism"], NodeSource> = {
  llm_prior: "llm_prior",
  web_search: "web_search",
  rag_document: "rag_document",
  multi_llm_consensus: "multi_llm_consensus",
  ensemble_forecast: "ensemble_forecast",
  empirical_observation: "empirical_observation",
  expert_panel: "expert_panel",
};

export interface BundleToNodeOptions {
  /**
   * SemanticConversation id that produced the bundle. Optional — only set
   * for Semantic Mode flows. Stored in NodeProvenance.conversationId for
   * traceability in exports and audit.
   */
  conversationId?: string;
}

/**
 * Build one UncertaintyNode from a research bundle + its component descriptor.
 *
 * The node's `range` defaults to [mean - 3*sd, mean + 3*sd] because the
 * engine uses range as the hard clip boundary for sampling and the bundles
 * do not carry an explicit min/max. Callers may override by editing the
 * returned node before handing it to the engine.
 *
 * Triangular distribution: if proposedParams has min + mode + max the
 * returned node includes those fields and derives mean/sd from the standard
 * triangular formulas so the engine receives a consistent shape.
 *
 * @param bundle  Accepted research bundle for one component.
 * @param component  The ProposedComponent this bundle researched.
 * @param opts  Optional metadata (conversationId for provenance).
 */
export function bundleToNode(
  bundle: ResearchBundle,
  component: ProposedComponent,
  opts: BundleToNodeOptions = {},
): UncertaintyNode {
  const source: NodeSource = MECHANISM_TO_NODE_SOURCE[bundle.mechanism];

  const provenance: NodeProvenance = {
    mechanism: source,
    citations: (bundle.citations ?? []).map((c) => ({
      source: c.source,
      url: c.url,
      title: c.title,
      snippet: c.snippet,
      documentId: c.documentId,
      chunkId: c.chunkId,
      chunkText: c.chunkText,
      sourceFilename: c.sourceFilename,
    })),
    reasoning: bundle.reasoning,
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    componentId: component.id,
  };

  const p = bundle.proposedParams;

  // Triangular distribution: derive mean and sd from min/mode/max.
  if (
    bundle.proposedDistribution === "triangular" &&
    typeof p.min === "number" &&
    typeof p.mode === "number" &&
    typeof p.max === "number"
  ) {
    const a = p.min;
    const c2 = p.mode;
    const b = p.max;
    const triMean = (a + c2 + b) / 3;
    const triVar = (a * a + c2 * c2 + b * b - a * c2 - a * b - c2 * b) / 18;
    const triSd = Math.sqrt(Math.max(0, triVar));

    return {
      id: component.id,
      name: component.name,
      description: component.description,
      distribution: "triangular",
      mean: triMean,
      sd: triSd,
      range: [a, b],
      unit: "",
      min: a,
      mode: c2,
      max: b,
      source,
      provenance,
    };
  }

  // All other distributions: use mean + sd from the bundle params.
  const mean = typeof p.mean === "number" ? p.mean : 0;
  const sd = typeof p.sd === "number" && p.sd > 0 ? p.sd : 0.001;

  // For beta/uniform, honour explicit min/max when present.
  const rangeMin =
    typeof p.min === "number" ? p.min : mean - 3 * sd;
  const rangeMax =
    typeof p.max === "number" ? p.max : mean + 3 * sd;

  const node: UncertaintyNode = {
    id: component.id,
    name: component.name,
    description: component.description,
    distribution: bundle.proposedDistribution,
    mean,
    sd,
    range: [rangeMin, rangeMax],
    unit: "",
    source,
    provenance,
  };

  // Lognormal / beta: carry alpha/beta params if the bundle supplied them.
  if (typeof p.alpha === "number" && typeof p.beta === "number") {
    // alpha/beta aren't standard UncertaintyNode fields, but we won't drop
    // them; instead re-derive mean/sd from the alpha+beta for beta dist.
    if (bundle.proposedDistribution === "beta") {
      const alpha = p.alpha;
      const beta = p.beta;
      const betaMean = alpha / (alpha + beta);
      const betaVar = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
      node.mean = betaMean;
      node.sd = Math.sqrt(betaVar);
      node.range = [0, 1];
    }
  }

  return node;
}
