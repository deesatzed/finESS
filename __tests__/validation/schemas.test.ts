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
});
