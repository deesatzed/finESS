import type { SimulationPhase } from "@/lib/types";

export interface AnalysisStatusInput {
  hasGraph: boolean;
  hasResult: boolean;
  phase: SimulationPhase;
  savedAnalysisId: string | null;
  hasUnsavedChanges: boolean;
}

export interface AnalysisStatus {
  label: string;
  detail: string;
  nextAction: string;
  canSave: boolean;
  canCalibrate: boolean;
  shortId: string | null;
}

export function getAnalysisStatus(input: AnalysisStatusInput): AnalysisStatus {
  const shortId = input.savedAnalysisId?.slice(0, 8) ?? null;

  if (!input.hasGraph) {
    return {
      label: "No analysis yet",
      detail: "Start with the instant PE demo or enter a custom question.",
      nextAction: "Run the instant demo",
      canSave: false,
      canCalibrate: false,
      shortId,
    };
  }

  if (input.phase === "running") {
    return {
      label: "Simulation running",
      detail: "Monte Carlo samples are updating the dashboard.",
      nextAction: "Wait for completion",
      canSave: false,
      canCalibrate: false,
      shortId,
    };
  }

  if (!input.hasResult) {
    return {
      label: "Analysis in progress",
      detail: "The graph exists but no completed result is available yet.",
      nextAction: "Run simulation",
      canSave: false,
      canCalibrate: false,
      shortId,
    };
  }

  if (input.savedAnalysisId && input.hasUnsavedChanges) {
    return {
      label: "Unsaved changes",
      detail: `Saved ID ${shortId}; current edits are not saved.`,
      nextAction: "Save changes before calibration",
      canSave: true,
      canCalibrate: false,
      shortId,
    };
  }

  if (input.savedAnalysisId) {
    return {
      label: "Saved analysis",
      detail: `Saved ID ${shortId}. Seed and result are preserved locally.`,
      nextAction: "Record outcome",
      canSave: true,
      canCalibrate: true,
      shortId,
    };
  }

  return {
    label: "Unsaved analysis",
    detail: "This completed result exists only in the current browser session.",
    nextAction: "Save before recording outcomes",
    canSave: true,
    canCalibrate: false,
    shortId,
  };
}
