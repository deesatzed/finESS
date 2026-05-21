/**
 * D3 — Semantic conversation export.
 *
 * Two formats:
 *  - Markdown: a human-readable defensibility document that traces every
 *    research decision, citation, and component distribution. Suitable
 *    for clinical / regulatory audit trails.
 *  - JSON: the structured `SemanticConversationExport` shape that can be
 *    re-imported for reproducibility checks (same query + same accepted
 *    bundles should produce statistically equivalent model runs).
 *
 * Design:
 *  - Pure functions — zero I/O. The caller loads the PersistedSemanticConversation
 *    and passes it in; these functions just transform it.
 *  - Only terminal states (REVIEWING_RESULT, COMPLETE) carry a meaningful
 *    result + bundles. Callers may export in-progress conversations
 *    (partial export), but the result block will be absent.
 *  - No PII written: the conversation `query` is included (it was supplied
 *    by the operator), answers to clarifying questions are included in
 *    summary form, but RAG chunk text is NOT echoed into the export
 *    (citation references are enough for re-import).
 */

import type { PersistedSemanticConversation } from "@/lib/semantic/persistence";
import type {
  ResearchBundle,
  ResearchCitation,
  ProposedComponent,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// JSON export type
// ---------------------------------------------------------------------------

export interface SemanticConversationExport {
  /** Schema version — bump on breaking changes to this shape. */
  exportSchemaVersion: "1.0";
  exportedAt: string;
  conversationId: string;
  query: string;
  stateKind: string;
  /** Clarifying Q&A pairs used to focus the research. */
  clarifications: Array<{ question: string; answer: string }>;
  /** Components identified for research. */
  components: Array<{
    id: string;
    name: string;
    description: string;
    suggestedDistribution?: string;
    dependsOn?: string[];
  }>;
  /** Research bundles, keyed by componentId. Only present after research. */
  research: Record<
    string,
    {
      mechanism: string;
      proposedDistribution: string;
      proposedParams: Record<string, number | undefined>;
      reasoning: string;
      citations: ResearchCitation[];
    }
  >;
  /** Decision threshold (only in SETTING_THRESHOLD and beyond). */
  threshold?: number;
  thresholdLabel?: string;
  /** Model run result, when the conversation reached REVIEWING_RESULT or COMPLETE. */
  result?: {
    topSensitivityComponentId?: string;
    pAboveThreshold?: number;
  };
}

// ---------------------------------------------------------------------------
// exportToJson
// ---------------------------------------------------------------------------

/**
 * Serialize the conversation to the `SemanticConversationExport` shape.
 * The returned object is JSON-serializable and importable.
 */
export function exportToJson(
  conversation: PersistedSemanticConversation,
): SemanticConversationExport {
  const s = conversation.state;

  const clarifications =
    "questions" in s && "answers" in s && s.questions && s.answers
      ? (s.questions as Array<{ id: string; question: string }>).map((q) => ({
          question: q.question,
          answer: ((s.answers as Record<string, string>) ?? {})[q.id] ?? "",
        }))
      : [];

  const components =
    "components" in s && Array.isArray(s.components)
      ? (s.components as ProposedComponent[]).map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          suggestedDistribution: c.suggestedDistribution,
          dependsOn: c.dependsOn,
        }))
      : [];

  const research: SemanticConversationExport["research"] = {};
  if ("bundles" in s && s.bundles && typeof s.bundles === "object") {
    for (const [componentId, bundle] of Object.entries(
      s.bundles as Record<string, ResearchBundle>,
    )) {
      research[componentId] = {
        mechanism: bundle.mechanism,
        proposedDistribution: bundle.proposedDistribution,
        proposedParams: { ...bundle.proposedParams } as Record<
          string,
          number | undefined
        >,
        reasoning: bundle.reasoning,
        citations: bundle.citations ?? [],
      };
    }
  }

  const threshold = "threshold" in s ? (s.threshold as number) : undefined;
  const thresholdLabel =
    "thresholdLabel" in s ? (s.thresholdLabel as string) : undefined;

  let result: SemanticConversationExport["result"] | undefined;
  if (
    "result" in s &&
    s.result &&
    typeof s.result === "object"
  ) {
    const r = s.result as { topSensitivityComponentId?: string; pAboveThreshold?: number };
    result = {
      topSensitivityComponentId: r.topSensitivityComponentId,
      pAboveThreshold: r.pAboveThreshold,
    };
  }

  return {
    exportSchemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    conversationId: conversation.id,
    query: conversation.query,
    stateKind: s.kind,
    clarifications,
    components,
    research,
    threshold,
    thresholdLabel,
    result,
  };
}

// ---------------------------------------------------------------------------
// exportToMarkdown
// ---------------------------------------------------------------------------

const MECHANISM_LABEL: Record<string, string> = {
  llm_prior: "LLM prior",
  web_search: "Web search (Tavily)",
  rag_document: "Document RAG",
  multi_llm_consensus: "Multi-LLM consensus",
  ensemble_forecast: "Ensemble forecast",
  empirical_observation: "Empirical observation",
  expert_panel: "Expert panel",
};

function citationLine(c: ResearchCitation, idx: number): string {
  const parts: string[] = [`[${idx + 1}]`];
  if (c.url) {
    parts.push(c.title ? `[${c.title}](${c.url})` : c.url);
  } else if (c.source) {
    parts.push(c.source);
  } else if (c.documentId) {
    const label = c.sourceFilename ?? `document ${c.documentId}`;
    const chunk = c.chunkId !== undefined ? ` (chunk ${c.chunkId})` : "";
    parts.push(`${label}${chunk}`);
  }
  if (c.snippet) {
    const snip = c.snippet.length > 200 ? c.snippet.slice(0, 200) + "…" : c.snippet;
    parts.push(`— "${snip}"`);
  }
  return `  ${parts.join(" ")}`;
}

function formatParams(params: Record<string, number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${(v as number).toPrecision(4)}`)
    .join(", ");
}

/**
 * Render the conversation as a Markdown defensibility document.
 *
 * The Markdown is structured for readability by human reviewers (clinical
 * boards, auditors, PIs) — it is not intended for machine parsing. Use
 * `exportToJson` for programmatic re-import.
 */
export function exportToMarkdown(
  conversation: PersistedSemanticConversation,
): string {
  const ex = exportToJson(conversation);
  const lines: string[] = [];

  lines.push(`# Uncertainty Analysis — Defensibility Document`);
  lines.push(``);
  lines.push(`**Conversation ID:** \`${ex.conversationId}\``);
  lines.push(`**Exported:** ${ex.exportedAt}`);
  lines.push(`**Status:** ${ex.stateKind}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // --- Query ---
  lines.push(`## Query`);
  lines.push(``);
  lines.push(`> ${ex.query}`);
  lines.push(``);

  // --- Clarifications ---
  if (ex.clarifications.length > 0) {
    lines.push(`## Clarifying Questions & Answers`);
    lines.push(``);
    for (const qa of ex.clarifications) {
      lines.push(`**Q:** ${qa.question}`);
      lines.push(`**A:** ${qa.answer || "_not answered_"}`);
      lines.push(``);
    }
  }

  // --- Components ---
  if (ex.components.length > 0) {
    lines.push(`## Uncertain Components`);
    lines.push(``);
    for (const c of ex.components) {
      lines.push(`### ${c.name}`);
      lines.push(``);
      lines.push(`*${c.description}*`);
      if (c.suggestedDistribution) {
        lines.push(``);
        lines.push(`Suggested distribution: **${c.suggestedDistribution}**`);
      }
      if (c.dependsOn && c.dependsOn.length > 0) {
        lines.push(`Depends on: ${c.dependsOn.join(", ")}`);
      }
      lines.push(``);
    }
  }

  // --- Decision threshold ---
  if (ex.threshold !== undefined) {
    lines.push(`## Decision Threshold`);
    lines.push(``);
    const label = ex.thresholdLabel ?? "threshold";
    lines.push(`**"${label}"** at **${ex.threshold}**`);
    lines.push(``);
  }

  // --- Research bundles ---
  const researchKeys = Object.keys(ex.research);
  if (researchKeys.length > 0) {
    lines.push(`## Research Results`);
    lines.push(``);

    for (const componentId of researchKeys) {
      const bundle = ex.research[componentId];
      const component = ex.components.find((c) => c.id === componentId);
      const name = component?.name ?? componentId;
      const mech = MECHANISM_LABEL[bundle.mechanism] ?? bundle.mechanism;

      lines.push(`### ${name}`);
      lines.push(``);
      lines.push(`**Mechanism:** ${mech}`);
      lines.push(
        `**Proposed:** ${bundle.proposedDistribution}(${formatParams(bundle.proposedParams)})`,
      );
      lines.push(``);
      lines.push(`**Reasoning:**`);
      lines.push(``);
      lines.push(`> ${bundle.reasoning.replace(/\n/g, "\n> ")}`);
      lines.push(``);

      if (bundle.citations.length > 0) {
        lines.push(`**Citations:**`);
        lines.push(``);
        bundle.citations.forEach((c, i) => {
          lines.push(citationLine(c, i));
        });
        lines.push(``);
      }
    }
  }

  // --- Model result ---
  if (ex.result) {
    lines.push(`## Model Result`);
    lines.push(``);
    if (ex.result.pAboveThreshold !== undefined) {
      const pct = (ex.result.pAboveThreshold * 100).toFixed(1);
      const label = ex.thresholdLabel ?? "threshold";
      lines.push(
        `P(exceeds "${label}") = **${pct}%**`,
      );
      lines.push(``);
      lines.push(
        `> Read the full cockpit distribution — a point estimate alone hides the spread.`,
      );
      lines.push(``);
    }
    if (ex.result.topSensitivityComponentId) {
      const topC = ex.components.find(
        (c) => c.id === ex.result!.topSensitivityComponentId,
      );
      if (topC) {
        lines.push(`**Top sensitivity driver:** ${topC.name}`);
        lines.push(``);
      }
    }
  }

  // --- Honesty footer ---
  lines.push(`---`);
  lines.push(``);
  lines.push(`*This document was generated by finESS (local uncertainty workbench).*`);
  lines.push(`*It is a tool to make uncertain reasoning explicit, not a clinical or*`);
  lines.push(`*legal recommendation. All distributions should be reviewed by a domain*`);
  lines.push(`*expert before acting on the results.*`);
  lines.push(``);

  return lines.join("\n");
}
