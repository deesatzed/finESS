import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import {
  validateAnalysisSaveRequest,
  validateCalibrationOutcomeRequest,
  validateUncertaintyGraph,
} from "@/lib/validation/schemas";

const UNSUPPORTED_METHOD = ["cus", "tom"].join("");

describe("runtime validation schemas", () => {
  test("accepts the built-in PE graph", () => {
    expect(validateUncertaintyGraph(PE_EXAMPLE_GRAPH)).toEqual(PE_EXAMPLE_GRAPH);
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
