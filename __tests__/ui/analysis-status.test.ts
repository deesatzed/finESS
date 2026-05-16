import { getAnalysisStatus } from "@/lib/ui/analysis-status";

describe("getAnalysisStatus", () => {
  test("reports empty state before a graph exists", () => {
    const status = getAnalysisStatus({
      hasGraph: false,
      hasResult: false,
      phase: "idle",
      savedAnalysisId: null,
      hasUnsavedChanges: false,
    });

    expect(status.label).toBe("No analysis yet");
    expect(status.canSave).toBe(false);
    expect(status.canCalibrate).toBe(false);
    expect(status.nextAction).toBe("Run the instant demo");
  });

  test("reports a completed unsaved analysis", () => {
    const status = getAnalysisStatus({
      hasGraph: true,
      hasResult: true,
      phase: "complete",
      savedAnalysisId: null,
      hasUnsavedChanges: true,
    });

    expect(status.label).toBe("Unsaved analysis");
    expect(status.canSave).toBe(true);
    expect(status.canCalibrate).toBe(false);
    expect(status.nextAction).toBe("Save before recording outcomes");
  });

  test("enables calibration for saved completed analyses", () => {
    const status = getAnalysisStatus({
      hasGraph: true,
      hasResult: true,
      phase: "complete",
      savedAnalysisId: "abc123456789",
      hasUnsavedChanges: false,
    });

    expect(status.label).toBe("Saved analysis");
    expect(status.shortId).toBe("abc12345");
    expect(status.canSave).toBe(true);
    expect(status.canCalibrate).toBe(true);
    expect(status.nextAction).toBe("Record outcome");
  });

  test("marks saved analyses dirty after graph edits", () => {
    const status = getAnalysisStatus({
      hasGraph: true,
      hasResult: true,
      phase: "complete",
      savedAnalysisId: "abc123456789",
      hasUnsavedChanges: true,
    });

    expect(status.label).toBe("Unsaved changes");
    expect(status.canCalibrate).toBe(false);
    expect(status.nextAction).toBe("Save changes before calibration");
  });
});
