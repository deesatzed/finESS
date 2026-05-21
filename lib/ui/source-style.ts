/**
 * Centralized visual mapping for node provenance (NodeSource).
 *
 * Used everywhere the UI surfaces a node's epistemic origin: the modal
 * editor's panel stripe + header pill, the multi-proposer list, and any
 * future colour-coded views. Keep this the single source of truth so
 * "literature green" / "llm_prior amber" / "user_override sky" stays
 * consistent across components.
 *
 * Colours follow the same palette as PathADraftBanner (amber for LLM-
 * generated draft content) and ForecastPanel's honesty banner (emerald
 * for evidenced). Sky-blue is reserved for explicit user edits.
 */

import type { NodeImpact, NodeSource } from "@/lib/types";

export interface SourceStyle {
  /** Short human-readable label for tooltips and pills. */
  label: string;
  /** Tooltip text that explains what the source means. */
  title: string;
  /** Tailwind class for left-edge stripes (border-l-4 + this). */
  borderClass: string;
  /** Tailwind class for the dot indicator on a pill. */
  dotClass: string;
  /** Tailwind class for the pill's text + background. */
  pillClass: string;
}

const STYLES: Record<NodeSource, SourceStyle> = {
  literature: {
    label: "literature",
    title:
      "Values cited from published research. Lowest hallucination risk.",
    borderClass: "border-emerald-500",
    dotClass: "bg-emerald-500",
    pillClass: "bg-emerald-500/15 text-emerald-300",
  },
  llm_prior: {
    label: "llm prior",
    title:
      "Values reflect the LLM's training prior. Draft only — verify before relying on the output.",
    borderClass: "border-amber-500",
    dotClass: "bg-amber-500",
    pillClass: "bg-amber-500/15 text-amber-300",
  },
  user_override: {
    label: "user edit",
    title:
      "Values were edited by the operator in the local session. Treat as the operator's working assumption.",
    borderClass: "border-sky-500",
    dotClass: "bg-sky-500",
    pillClass: "bg-sky-500/15 text-sky-300",
  },
  web_search: {
    label: "web search",
    title:
      "Values extracted from live web-search results (Tavily). Grounded in real sources — verify the linked URLs.",
    borderClass: "border-violet-500",
    dotClass: "bg-violet-500",
    pillClass: "bg-violet-500/15 text-violet-300",
  },
  rag_document: {
    label: "document",
    title:
      "Values extracted from operator-uploaded documents via RAG. Source text shown in citations.",
    borderClass: "border-teal-500",
    dotClass: "bg-teal-500",
    pillClass: "bg-teal-500/15 text-teal-300",
  },
  multi_llm_consensus: {
    label: "consensus",
    title:
      "Values synthesised from multiple LLMs. Disagreement score indicates epistemic spread.",
    borderClass: "border-indigo-500",
    dotClass: "bg-indigo-500",
    pillClass: "bg-indigo-500/15 text-indigo-300",
  },
  ensemble_forecast: {
    label: "ensemble",
    title:
      "Values derived from the ace_hospital ensemble forecast sidecar. Grounded in local model outputs.",
    borderClass: "border-cyan-500",
    dotClass: "bg-cyan-500",
    pillClass: "bg-cyan-500/15 text-cyan-300",
  },
  empirical_observation: {
    label: "empirical",
    title:
      "Values computed from operator-supplied CSV observation data. No LLM hallucination at the modeling layer.",
    borderClass: "border-lime-500",
    dotClass: "bg-lime-500",
    pillClass: "bg-lime-500/15 text-lime-300",
  },
  expert_panel: {
    label: "expert panel",
    title:
      "Values derived from operator-supplied expert estimates. No LLM call — pure statistical transform.",
    borderClass: "border-rose-500",
    dotClass: "bg-rose-500",
    pillClass: "bg-rose-500/15 text-rose-300",
  },
};

/**
 * Resolve a node source (which may be undefined on legacy graphs) to its
 * visual style. Defaults to `llm_prior` styling because that is the
 * conservative assumption when provenance is unknown.
 */
export function getSourceStyle(source: NodeSource | undefined): SourceStyle {
  if (source === undefined) return STYLES.llm_prior;
  return STYLES[source];
}

/**
 * Visual style for operator-assigned NodeImpact (C4).
 *
 * Separate dimension from provenance: a node can simultaneously be
 * `user_override` source AND `critical` impact. The UI shows two pills
 * side by side. Colours intentionally do NOT overlap with the
 * provenance palette (which uses emerald / amber / sky) so the two
 * dimensions stay visually distinguishable. Impact uses neutral grey
 * for low, blue for medium, orange for high, red for critical — a
 * conventional severity ramp.
 */
export interface ImpactStyle {
  label: string;
  title: string;
  pillClass: string;
  dotClass: string;
}

const IMPACT_STYLES: Record<NodeImpact, ImpactStyle> = {
  low: {
    label: "low impact",
    title:
      "Operator-assigned: this factor is unlikely to materially move the result.",
    pillClass: "bg-slate-500/15 text-slate-300",
    dotClass: "bg-slate-400",
  },
  medium: {
    label: "medium impact",
    title:
      "Operator-assigned: this factor has moderate leverage on the result.",
    pillClass: "bg-blue-500/15 text-blue-300",
    dotClass: "bg-blue-400",
  },
  high: {
    label: "high impact",
    title:
      "Operator-assigned: this factor likely drives the result; verify carefully.",
    pillClass: "bg-orange-500/15 text-orange-300",
    dotClass: "bg-orange-400",
  },
  critical: {
    label: "critical",
    title:
      "Operator-assigned: getting this wrong invalidates the analysis. Top priority for verification.",
    pillClass: "bg-red-500/15 text-red-300",
    dotClass: "bg-red-400",
  },
};

export function getImpactStyle(impact: NodeImpact | undefined): ImpactStyle | null {
  if (impact === undefined) return null;
  return IMPACT_STYLES[impact];
}
