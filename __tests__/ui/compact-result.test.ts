import {
  compactAnalysisResultForSave,
  compactSimulationResultForSave,
} from "@/lib/ui/compact-result";
import type { SimulationResult, UncertaintyGraph } from "@/lib/types";

describe("compactSimulationResultForSave", () => {
  test("preserves summary statistics and seed while dropping bulky sample arrays", () => {
    const result: SimulationResult = {
      samples: [0.1, 0.2, 0.3],
      mean: 0.2,
      median: 0.2,
      ciLow: 0.1,
      ciHigh: 0.3,
      pAboveThreshold: 0.5,
      seed: 42,
      nodeSamples: {
        a: [0.1, 0.2],
      },
    };

    expect(compactSimulationResultForSave(result)).toEqual({
      samples: [],
      mean: 0.2,
      median: 0.2,
      ciLow: 0.1,
      ciHigh: 0.3,
      pAboveThreshold: 0.5,
      seed: 42,
      nodeSamples: {},
    });
  });

  test("keeps observed samples because they are the source data", () => {
    const result: SimulationResult = {
      samples: [0, 1, 1],
      mean: 2 / 3,
      median: 1,
      ciLow: 0,
      ciHigh: 1,
      pAboveThreshold: 2 / 3,
      seed: 0,
      nodeSamples: { observed_values: [0, 1, 1] },
    };
    const graph: UncertaintyGraph = {
      analysisMode: "observed",
      nodes: [
        {
          id: "observed_values",
          name: "Observed Values",
          description: "Observed",
          distribution: "normal",
          mean: 2 / 3,
          sd: 0.5,
          range: [0, 1],
          unit: "outcome",
        },
      ],
      edges: [
        {
          id: "observed_to_summary",
          source: "observed_values",
          target: "observed_values",
          method: "additive",
        },
      ],
      outputNodeId: "observed_values",
    };

    expect(compactAnalysisResultForSave(result, graph)).toBe(result);
  });
});
