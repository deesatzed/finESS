import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import {
  validateAnalysisSaveRequest,
  validateCalibrationOutcomeRequest,
  validateUncertaintyGraph,
} from "@/lib/validation/schemas";

const UNSUPPORTED_METHOD = ["cus", "tom"].join("");

describe("runtime validation schemas", () => {
  test("accepts the built-in PE graph and populates source on every node", () => {
    // M8-08: the validator now carries node.source / node.sourceNote through
    // save/load. PE_EXAMPLE_GRAPH is a legacy fixture without source set, so
    // each node gets coerced to "llm_prior". Edges, output, threshold, and
    // narration are unaffected.
    const validated = validateUncertaintyGraph(PE_EXAMPLE_GRAPH);
    expect(validated.edges).toEqual(PE_EXAMPLE_GRAPH.edges);
    expect(validated.outputNodeId).toBe(PE_EXAMPLE_GRAPH.outputNodeId);
    expect(validated.threshold).toBe(PE_EXAMPLE_GRAPH.threshold);
    expect(validated.narration).toBe(PE_EXAMPLE_GRAPH.narration);
    expect(validated.nodes).toHaveLength(PE_EXAMPLE_GRAPH.nodes.length);
    for (const node of validated.nodes) {
      expect(node.source).toBe("llm_prior");
    }
  });

  test("rejects unsupported edge methods", () => {
    const graph = {
      ...PE_EXAMPLE_GRAPH,
      edges: [
        {
          ...PE_EXAMPLE_GRAPH.edges[0],
          method: UNSUPPORTED_METHOD,
        },
      ],
    };

    expect(() => validateUncertaintyGraph(graph)).toThrow("invalid method");
  });

  test("rejects oversized analysis save payloads", () => {
    expect(() =>
      validateAnalysisSaveRequest({
        query: "x".repeat(20_001),
        graph: PE_EXAMPLE_GRAPH,
      })
    ).toThrow("query is too large");
  });

  test("accepts valid analysis save payloads", () => {
    const payload = validateAnalysisSaveRequest({
      query: "PE demo",
      graph: PE_EXAMPLE_GRAPH,
      result: null,
      sensitivity: null,
      seed: 42,
    });

    expect(payload.query).toBe("PE demo");
    expect(payload.seed).toBe(42);
  });

  test("rejects calibration probability outside 0..1", () => {
    expect(() =>
      validateCalibrationOutcomeRequest({
        analysisId: "abc",
        predictedProbability: 1.2,
        actualOutcome: true,
      })
    ).toThrow("predictedProbability");
  });

  describe("triangular distribution (C1)", () => {
    const validTriangularNode = {
      id: "infl",
      name: "Inflation",
      description: "annual inflation rate",
      distribution: "triangular",
      mean: 0.03,
      sd: 0.01,
      range: [0, 0.1],
      unit: "%",
      min: 0.018,
      mode: 0.028,
      max: 0.055,
    };
    const baseGraph = {
      nodes: [validTriangularNode],
      edges: [{ id: "e1", source: "infl", target: "out", method: "additive" }],
      outputNodeId: "out",
    };

    test("accepts a well-formed triangular graph and preserves min/mode/max", () => {
      const validated = validateUncertaintyGraph(baseGraph);
      expect(validated.nodes[0].distribution).toBe("triangular");
      expect(validated.nodes[0].min).toBe(0.018);
      expect(validated.nodes[0].mode).toBe(0.028);
      expect(validated.nodes[0].max).toBe(0.055);
    });

    test("rejects triangular node missing min", () => {
      const bad = {
        ...baseGraph,
        nodes: [{ ...validTriangularNode, min: undefined }],
      };
      expect(() => validateUncertaintyGraph(bad)).toThrow(
        /missing numeric min\/mode\/max/
      );
    });

    test("rejects triangular with mode outside [min, max]", () => {
      const bad = {
        ...baseGraph,
        nodes: [{ ...validTriangularNode, min: 0.5, mode: 0.1, max: 0.9 }],
      };
      expect(() => validateUncertaintyGraph(bad)).toThrow(
        /min <= mode <= max/
      );
    });
  });

  describe("Bernoulli mixture gate (C2)", () => {
    const baseNode = {
      id: "repair",
      name: "Repair",
      description: "rare hit",
      distribution: "lognormal",
      mean: 1000,
      sd: 500,
      range: [0, 100000],
      unit: "$",
    };
    const baseGraph = (gate: unknown) => ({
      nodes: [{ ...baseNode, gate }],
      edges: [{ id: "e1", source: "repair", target: "out", method: "additive" }],
      outputNodeId: "out",
    });

    test("accepts a well-formed gate and preserves it through save/load", () => {
      const validated = validateUncertaintyGraph(baseGraph({ probability: 0.12 }));
      expect(validated.nodes[0].gate).toEqual({ probability: 0.12 });
    });

    test("preserves inactiveValue through save/load", () => {
      const validated = validateUncertaintyGraph(
        baseGraph({ probability: 0.4, inactiveValue: -50 })
      );
      expect(validated.nodes[0].gate).toEqual({ probability: 0.4, inactiveValue: -50 });
    });

    test("rejects probability outside [0, 1]", () => {
      expect(() => validateUncertaintyGraph(baseGraph({ probability: 2 }))).toThrow(
        /must be in \[0, 1\]/
      );
    });

    test("rejects non-object gate", () => {
      expect(() => validateUncertaintyGraph(baseGraph(0.5))).toThrow(/invalid gate/);
    });
  });

  describe("impact tag (C4)", () => {
    const baseNode = {
      id: "n1",
      name: "N1",
      description: "test",
      distribution: "normal",
      mean: 1,
      sd: 0.1,
      range: [0, 10],
      unit: "%",
    };

    test("preserves valid impact through save/load", () => {
      for (const impact of ["low", "medium", "high", "critical"] as const) {
        const validated = validateUncertaintyGraph({
          nodes: [{ ...baseNode, impact }],
          edges: [{ id: "e1", source: "n1", target: "out", method: "additive" }],
          outputNodeId: "out",
        });
        expect(validated.nodes[0].impact).toBe(impact);
      }
    });

    test("rejects invalid impact at save time", () => {
      expect(() =>
        validateUncertaintyGraph({
          nodes: [{ ...baseNode, impact: "blocker" }],
          edges: [{ id: "e1", source: "n1", target: "out", method: "additive" }],
          outputNodeId: "out",
        })
      ).toThrow(/invalid impact/);
    });
  });

  describe("NodeProvenance round-trip (D1)", () => {
    const baseNode = {
      id: "n1",
      name: "N1",
      description: "test",
      distribution: "normal",
      mean: 0.35,
      sd: 0.12,
      range: [0, 1],
      unit: "",
    };
    const baseGraph = (node: Record<string, unknown>) => ({
      nodes: [node],
      edges: [{ id: "e1", source: "n1", target: "out", method: "additive" }],
      outputNodeId: "out",
    });

    test("preserves provenance block with mechanism + citations through save/load", () => {
      const provenance = {
        mechanism: "web_search",
        citations: [{ url: "https://example.com", title: "Source", snippet: "snip" }],
        reasoning: "Grounded in real sources.",
        conversationId: "conv-1",
        componentId: "n1",
      };
      const validated = validateUncertaintyGraph(
        baseGraph({ ...baseNode, source: "web_search", provenance })
      );
      const p = validated.nodes[0].provenance!;
      expect(p.mechanism).toBe("web_search");
      expect(p.citations).toHaveLength(1);
      expect(p.citations[0].url).toBe("https://example.com");
      expect(p.citations[0].title).toBe("Source");
      expect(p.citations[0].snippet).toBe("snip");
      expect(p.reasoning).toBe("Grounded in real sources.");
      expect(p.conversationId).toBe("conv-1");
      expect(p.componentId).toBe("n1");
    });

    test("preserves RAG citation fields (documentId, chunkId, chunkText, sourceFilename)", () => {
      const provenance = {
        mechanism: "rag_document",
        citations: [
          {
            documentId: "doc-1",
            chunkId: 2,
            chunkText: "chunk content here",
            sourceFilename: "paper.pdf",
          },
        ],
      };
      const validated = validateUncertaintyGraph(
        baseGraph({ ...baseNode, source: "rag_document", provenance })
      );
      const cit = validated.nodes[0].provenance!.citations[0];
      expect(cit.documentId).toBe("doc-1");
      expect(cit.chunkId).toBe(2);
      expect(cit.chunkText).toBe("chunk content here");
      expect(cit.sourceFilename).toBe("paper.pdf");
    });

    test("omits provenance when not present (legacy nodes)", () => {
      const validated = validateUncertaintyGraph(baseGraph({ ...baseNode }));
      expect(validated.nodes[0].provenance).toBeUndefined();
    });

    test("coerces unknown mechanism to llm_prior and keeps citations", () => {
      const provenance = {
        mechanism: "unknown_future_mechanism",
        citations: [{ source: "x" }],
      };
      const validated = validateUncertaintyGraph(
        baseGraph({ ...baseNode, provenance })
      );
      expect(validated.nodes[0].provenance!.mechanism).toBe("llm_prior");
      expect(validated.nodes[0].provenance!.citations).toHaveLength(1);
    });

    test("accepts all nine NodeSource values for node.source", () => {
      const sources = [
        "literature", "llm_prior", "user_override",
        "web_search", "rag_document", "multi_llm_consensus",
        "ensemble_forecast", "empirical_observation", "expert_panel",
      ] as const;
      for (const source of sources) {
        const validated = validateUncertaintyGraph(
          baseGraph({ ...baseNode, source })
        );
        expect(validated.nodes[0].source).toBe(source);
      }
    });

    test("coerces unknown node.source to llm_prior", () => {
      const validated = validateUncertaintyGraph(
        baseGraph({ ...baseNode, source: "future_unknown" })
      );
      expect(validated.nodes[0].source).toBe("llm_prior");
    });
  });
});
