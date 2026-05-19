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
});
