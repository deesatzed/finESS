import { analyzeObservedRows } from "@/lib/real-data/analyze";

describe("analyzeObservedRows", () => {
  test("computes empirical binary outcome results without simulation", () => {
    const analysis = analyzeObservedRows(
      [
        { outcome: "yes" },
        { outcome: "no" },
        { outcome: "yes" },
        { outcome: "yes" },
      ],
      "outcome"
    );

    expect(analysis.graph.analysisMode).toBe("observed");
    expect(analysis.result.samples).toEqual([1, 0, 1, 1]);
    expect(analysis.result.mean).toBe(0.75);
    expect(analysis.result.pAboveThreshold).toBe(0.75);
    expect(analysis.result.seed).toBe(0);
    expect(analysis.totalRows).toBe(4);
    expect(analysis.missingCount).toBe(0);
    expect(analysis.narration).toContain("Observed-data analysis");
  });

  test("computes threshold exceedance for numeric targets", () => {
    const analysis = analyzeObservedRows(
      [{ value: "10" }, { value: "20" }, { value: "30" }],
      "value",
      15
    );

    expect(analysis.result.mean).toBe(20);
    expect(analysis.graph.threshold).toBe(15);
    expect(analysis.result.pAboveThreshold).toBe(2 / 3);
  });

  test("rejects non-numeric target values", () => {
    expect(() => analyzeObservedRows([{ outcome: "maybe" }], "outcome")).toThrow(
      "Row 2 target value is not numeric or binary"
    );
  });
});
