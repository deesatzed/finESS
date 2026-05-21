/**
 * D3 — conversation export unit tests.
 *
 * Tests the pure export functions (exportToJson, exportToMarkdown) against
 * synthetic PersistedSemanticConversation fixtures covering the key state
 * kinds (CLARIFYING, REVIEWING_RESEARCH, COMPLETE) and all citation shapes.
 */

import {
  exportToJson,
  exportToMarkdown,
  type SemanticConversationExport,
} from "@/lib/semantic/export";
import type { PersistedSemanticConversation } from "@/lib/semantic/persistence";
import type { SemanticState } from "@/lib/semantic/state-machine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConversation(
  state: SemanticState,
  overrides: Partial<PersistedSemanticConversation> = {},
): PersistedSemanticConversation {
  return {
    id: "conv-test-001",
    userId: "user-1",
    workspaceId: "ws-1",
    query: "What is the probability a 55-year-old with chest pain has PE?",
    state,
    createdAt: "2026-05-21T00:00:00Z",
    updatedAt: "2026-05-21T01:00:00Z",
    ...overrides,
  };
}

const CLARIFYING_STATE: SemanticState = {
  kind: "CLARIFYING",
  query: "What is the probability a 55-year-old with chest pain has PE?",
  questions: [
    { id: "q1", question: "Risk factors present?" },
    { id: "q2", question: "D-dimer result?" },
  ],
  answers: { q1: "Yes — tachycardia + immobility", q2: "Elevated at 1.4" },
};

const COMPLETE_STATE: SemanticState = {
  kind: "COMPLETE",
  query: "What is the probability a 55-year-old with chest pain has PE?",
  questions: [
    { id: "q1", question: "Risk factors present?" },
    { id: "q2", question: "D-dimer result?" },
  ],
  answers: { q1: "Yes — tachycardia + immobility", q2: "Elevated at 1.4" },
  components: [
    {
      id: "c1",
      name: "Pretest probability",
      description: "Wells score estimate",
      suggestedDistribution: "beta",
    },
    {
      id: "c2",
      name: "D-dimer sensitivity",
      description: "ELISA performance",
    },
  ],
  threshold: 0.3,
  thresholdLabel: "clinical PE threshold",
  bundles: {
    c1: {
      componentId: "c1",
      mechanism: "web_search",
      proposedDistribution: "beta",
      proposedParams: { mean: 0.35, sd: 0.12 },
      reasoning: "Based on Wells 2001 validation cohort.",
      citations: [
        { url: "https://example.com/wells", title: "Wells 2001", snippet: "Moderate risk group" },
      ],
    },
    c2: {
      componentId: "c2",
      mechanism: "llm_prior",
      proposedDistribution: "normal",
      proposedParams: { mean: 0.95, sd: 0.03 },
      reasoning: "High-sensitivity ELISA typical performance.",
      citations: [{ source: "PIOPED II" }],
    },
  },
  result: {
    topSensitivityComponentId: "c1",
    pAboveThreshold: 0.72,
  },
};

// ---------------------------------------------------------------------------
// exportToJson
// ---------------------------------------------------------------------------

describe("exportToJson", () => {
  it("returns schema version 1.0", () => {
    const exp = exportToJson(makeConversation(CLARIFYING_STATE));
    expect(exp.exportSchemaVersion).toBe("1.0");
  });

  it("includes conversationId and query", () => {
    const exp = exportToJson(makeConversation(CLARIFYING_STATE));
    expect(exp.conversationId).toBe("conv-test-001");
    expect(exp.query).toContain("55-year-old");
  });

  it("maps stateKind from the current state", () => {
    const exp = exportToJson(makeConversation(CLARIFYING_STATE));
    expect(exp.stateKind).toBe("CLARIFYING");
  });

  it("includes clarifications with answers", () => {
    const exp = exportToJson(makeConversation(CLARIFYING_STATE));
    expect(exp.clarifications).toHaveLength(2);
    expect(exp.clarifications[0].question).toBe("Risk factors present?");
    expect(exp.clarifications[0].answer).toBe("Yes — tachycardia + immobility");
    expect(exp.clarifications[1].answer).toBe("Elevated at 1.4");
  });

  it("has empty components and research for CLARIFYING state", () => {
    const exp = exportToJson(makeConversation(CLARIFYING_STATE));
    expect(exp.components).toHaveLength(0);
    expect(Object.keys(exp.research)).toHaveLength(0);
  });

  it("includes components, research, threshold and result for COMPLETE state", () => {
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    expect(exp.stateKind).toBe("COMPLETE");
    expect(exp.components).toHaveLength(2);
    expect(exp.threshold).toBe(0.3);
    expect(exp.thresholdLabel).toBe("clinical PE threshold");
    expect(exp.result?.pAboveThreshold).toBeCloseTo(0.72);
    expect(exp.result?.topSensitivityComponentId).toBe("c1");
  });

  it("maps research bundles keyed by componentId", () => {
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    expect(exp.research).toHaveProperty("c1");
    expect(exp.research).toHaveProperty("c2");
    expect(exp.research["c1"].mechanism).toBe("web_search");
    expect(exp.research["c2"].mechanism).toBe("llm_prior");
  });

  it("preserves web_search citation with url + title + snippet", () => {
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    const cit = exp.research["c1"].citations[0];
    expect(cit.url).toBe("https://example.com/wells");
    expect(cit.title).toBe("Wells 2001");
    expect(cit.snippet).toBe("Moderate risk group");
  });

  it("preserves llm_prior citation with source field", () => {
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    const cit = exp.research["c2"].citations[0];
    expect(cit.source).toBe("PIOPED II");
  });

  it("is JSON-serializable (no circular refs, no undefined)", () => {
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    expect(() => JSON.stringify(exp)).not.toThrow();
    const reparsed = JSON.parse(JSON.stringify(exp)) as SemanticConversationExport;
    expect(reparsed.conversationId).toBe("conv-test-001");
  });

  it("includes exportedAt ISO timestamp", () => {
    const before = Date.now();
    const exp = exportToJson(makeConversation(COMPLETE_STATE));
    const after = Date.now();
    const ts = new Date(exp.exportedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// exportToMarkdown
// ---------------------------------------------------------------------------

describe("exportToMarkdown", () => {
  it("returns a string starting with a markdown H1", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toMatch(/^# Uncertainty Analysis/);
  });

  it("includes the conversation ID and export status", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("conv-test-001");
    expect(md).toContain("COMPLETE");
  });

  it("includes the query in a blockquote", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("> What is the probability");
  });

  it("renders clarifying Q&A section", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("Clarifying Questions");
    expect(md).toContain("Risk factors present?");
    expect(md).toContain("Yes — tachycardia + immobility");
  });

  it("renders component names with distribution suggestion", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("Pretest probability");
    expect(md).toContain("Wells score estimate");
    expect(md).toContain("beta");
  });

  it("renders the decision threshold", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("clinical PE threshold");
    expect(md).toContain("0.3");
  });

  it("renders the research section with mechanism label", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("Web search (Tavily)");
    expect(md).toContain("LLM prior");
  });

  it("renders citation URLs as markdown links", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("[Wells 2001](https://example.com/wells)");
  });

  it("renders citation source text for llm_prior citations", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("PIOPED II");
  });

  it("renders the model result with P(exceeds threshold)", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("72.0%");
    expect(md).toContain("clinical PE threshold");
  });

  it("includes the honesty footer disclaimer", () => {
    const md = exportToMarkdown(makeConversation(COMPLETE_STATE));
    expect(md).toContain("not a clinical or");
    expect(md).toContain("reviewed by a domain");
  });

  it("omits Research Results section for CLARIFYING state", () => {
    const md = exportToMarkdown(makeConversation(CLARIFYING_STATE));
    expect(md).not.toContain("## Research Results");
  });
});

// ---------------------------------------------------------------------------
// RAG citation rendering
// ---------------------------------------------------------------------------

describe("exportToMarkdown — RAG citations", () => {
  const ragState: SemanticState = {
    ...COMPLETE_STATE,
    bundles: {
      c1: {
        componentId: "c1",
        mechanism: "rag_document",
        proposedDistribution: "beta",
        proposedParams: { mean: 0.35, sd: 0.1 },
        reasoning: "Extracted from uploaded guidelines.",
        citations: [
          {
            documentId: "doc-1",
            chunkId: 3,
            sourceFilename: "guidelines.pdf",
            snippet: "Wells score moderate risk",
          },
        ],
      },
    },
  } as SemanticState;

  it("renders document filename + chunk reference for RAG citations", () => {
    const md = exportToMarkdown(makeConversation(ragState));
    expect(md).toContain("guidelines.pdf");
    expect(md).toContain("chunk 3");
  });

  it("renders mechanism label as Document RAG", () => {
    const md = exportToMarkdown(makeConversation(ragState));
    expect(md).toContain("Document RAG");
  });
});
