import type { SimulationResult, UncertaintyGraph } from "@/lib/types";

export function compactAnalysisResultForSave(
  result: SimulationResult | null,
  graph?: UncertaintyGraph | null
): SimulationResult | null {
  if (!result) return null;
  if (graph?.analysisMode === "observed") return result;

  return {
    ...result,
    samples: [],
    nodeSamples: {},
  };
}

export const compactSimulationResultForSave = compactAnalysisResultForSave;
