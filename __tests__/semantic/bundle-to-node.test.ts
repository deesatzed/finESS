/**
 * D1 — bundle-to-node unit tests.
 *
 * Covers every distribution path and the NodeProvenance field that attaches
 * the full citation chain to the resulting UncertaintyNode.
 */

import { bundleToNode } from "@/lib/semantic/bundle-to-node";
import type { ResearchBundle, ProposedComponent } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPONENT: ProposedComponent = {
  id: "c1",
  name: "Pretest probability",
  description: "Wells score estimate",
  suggestedDistribution: "beta",
};

function normalBundle(
  overrides: Partial<ResearchBundle> = {},
): ResearchBundle {
  return {
    componentId: "c1",
    mechanism: "llm_prior",
    proposedDistribution: "normal",
    proposedParams: { mean: 0.35, sd: 0.12 },
    reasoning: "Based on Wells score literature.",
    citations: [{ source: "Wells 2001" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("bundleToNode — normal distribution", () => {
  it("copies component id, name, description", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.id).toBe("c1");
    expect(node.name).toBe("Pretest probability");
    expect(node.description).toBe("Wells score estimate");
  });

  it("maps llm_prior mechanism to source='llm_prior'", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.source).toBe("llm_prior");
    expect(node.distribution).toBe("normal");
    expect(node.mean).toBeCloseTo(0.35);
    expect(node.sd).toBeCloseTo(0.12);
  });

  it("defaults range to [mean - 3*sd, mean + 3*sd]", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.range[0]).toBeCloseTo(0.35 - 3 * 0.12);
    expect(node.range[1]).toBeCloseTo(0.35 + 3 * 0.12);
  });

  it("honours explicit min/max for range when provided", () => {
    const node = bundleToNode(
      normalBundle({ proposedParams: { mean: 0.35, sd: 0.12, min: 0, max: 1 } }),
      COMPONENT,
    );
    expect(node.range[0]).toBe(0);
    expect(node.range[1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provenance block
// ---------------------------------------------------------------------------

describe("bundleToNode — NodeProvenance", () => {
  it("attaches provenance with mechanism and citations", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.provenance).toBeDefined();
    expect(node.provenance!.mechanism).toBe("llm_prior");
    expect(node.provenance!.citations).toHaveLength(1);
    expect(node.provenance!.citations[0].source).toBe("Wells 2001");
  });

  it("carries reasoning into provenance", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.provenance!.reasoning).toBe("Based on Wells score literature.");
  });

  it("attaches conversationId when supplied in opts", () => {
    const node = bundleToNode(normalBundle(), COMPONENT, {
      conversationId: "conv-abc",
    });
    expect(node.provenance!.conversationId).toBe("conv-abc");
  });

  it("always sets componentId from ProposedComponent.id", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.provenance!.componentId).toBe("c1");
  });

  it("creates empty citations array when bundle has no citations", () => {
    const b = normalBundle({ citations: undefined });
    const node = bundleToNode(b, COMPONENT);
    expect(node.provenance!.citations).toEqual([]);
  });

  it("preserves all citation fields (web_search case)", () => {
    const b = normalBundle({
      mechanism: "web_search",
      citations: [
        {
          url: "https://example.com/pe",
          title: "PE guidelines",
          snippet: "Wells score moderate risk",
        },
      ],
    });
    const node = bundleToNode(b, COMPONENT);
    expect(node.source).toBe("web_search");
    const cit = node.provenance!.citations[0];
    expect(cit.url).toBe("https://example.com/pe");
    expect(cit.title).toBe("PE guidelines");
    expect(cit.snippet).toBe("Wells score moderate risk");
  });

  it("preserves RAG citation fields", () => {
    const b = normalBundle({
      mechanism: "rag_document",
      citations: [
        {
          documentId: "doc-01",
          chunkId: 3,
          chunkText: "Wells score calculation",
          sourceFilename: "guidelines.pdf",
        },
      ],
    });
    const node = bundleToNode(b, COMPONENT);
    expect(node.source).toBe("rag_document");
    const cit = node.provenance!.citations[0];
    expect(cit.documentId).toBe("doc-01");
    expect(cit.chunkId).toBe(3);
    expect(cit.chunkText).toBe("Wells score calculation");
    expect(cit.sourceFilename).toBe("guidelines.pdf");
  });
});

// ---------------------------------------------------------------------------
// All mechanisms map to the correct NodeSource
// ---------------------------------------------------------------------------

const MECHANISM_SOURCES: Array<[ResearchBundle["mechanism"], string]> = [
  ["llm_prior", "llm_prior"],
  ["web_search", "web_search"],
  ["rag_document", "rag_document"],
  ["multi_llm_consensus", "multi_llm_consensus"],
  ["ensemble_forecast", "ensemble_forecast"],
  ["empirical_observation", "empirical_observation"],
  ["expert_panel", "expert_panel"],
];

describe("bundleToNode — mechanism → source mapping", () => {
  test.each(MECHANISM_SOURCES)(
    "mechanism=%s maps to source=%s",
    (mechanism, expectedSource) => {
      const node = bundleToNode(normalBundle({ mechanism }), COMPONENT);
      expect(node.source).toBe(expectedSource);
      expect(node.provenance!.mechanism).toBe(expectedSource);
    },
  );
});

// ---------------------------------------------------------------------------
// Triangular distribution
// ---------------------------------------------------------------------------

describe("bundleToNode — triangular distribution", () => {
  it("derives mean and sd from min/mode/max", () => {
    const node = bundleToNode(
      normalBundle({
        proposedDistribution: "triangular",
        proposedParams: { min: 0.1, mode: 0.3, max: 0.8 },
      }),
      COMPONENT,
    );
    expect(node.distribution).toBe("triangular");
    const expectedMean = (0.1 + 0.3 + 0.8) / 3;
    expect(node.mean).toBeCloseTo(expectedMean);
    expect(node.range[0]).toBe(0.1);
    expect(node.range[1]).toBe(0.8);
    expect(node.min).toBe(0.1);
    expect(node.mode).toBe(0.3);
    expect(node.max).toBe(0.8);
  });

  it("sd is non-negative", () => {
    const node = bundleToNode(
      normalBundle({
        proposedDistribution: "triangular",
        proposedParams: { min: 0.5, mode: 0.5, max: 0.5 },
      }),
      COMPONENT,
    );
    expect(node.sd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Beta distribution with alpha/beta params
// ---------------------------------------------------------------------------

describe("bundleToNode — beta distribution with alpha/beta", () => {
  it("re-derives mean/sd from alpha+beta and sets range [0,1]", () => {
    const alpha = 2;
    const beta = 5;
    const node = bundleToNode(
      normalBundle({
        proposedDistribution: "beta",
        proposedParams: { alpha, beta },
      }),
      COMPONENT,
    );
    expect(node.distribution).toBe("beta");
    const expectedMean = alpha / (alpha + beta);
    expect(node.mean).toBeCloseTo(expectedMean);
    expect(node.range[0]).toBe(0);
    expect(node.range[1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("bundleToNode — edge cases", () => {
  it("uses sd=0.001 when bundle sd is 0 to avoid engine division by zero", () => {
    const node = bundleToNode(
      normalBundle({ proposedParams: { mean: 0.5, sd: 0 } }),
      COMPONENT,
    );
    expect(node.sd).toBe(0.001);
  });

  it("uses mean=0 when bundle mean is absent", () => {
    const node = bundleToNode(
      normalBundle({ proposedParams: {} }),
      COMPONENT,
    );
    expect(node.mean).toBe(0);
  });

  it("unit is always empty string (not from bundle)", () => {
    const node = bundleToNode(normalBundle(), COMPONENT);
    expect(node.unit).toBe("");
  });
});
