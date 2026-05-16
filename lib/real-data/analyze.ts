import type {
  SensitivityResult,
  SimulationResult,
  UncertaintyGraph,
} from "@/lib/types";

export interface ObservedAnalysisResult {
  graph: UncertaintyGraph;
  result: SimulationResult;
  sensitivity: SensitivityResult[];
  narration: string;
  targetColumn: string;
  rowCount: number;
  totalRows: number;
  missingCount: number;
}

export class ObservedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservedDataError";
  }
}

export function analyzeObservedRows(
  rows: Record<string, string>[],
  targetColumn: string,
  threshold?: number | null
): ObservedAnalysisResult {
  if (rows.length === 0) {
    throw new ObservedDataError("Observed data must include at least one row");
  }
  if (!targetColumn) {
    throw new ObservedDataError("Select a target column");
  }

  const values = rows
    .map((row, index) => parseObservedValue(row[targetColumn], index + 2))
    .filter((value) => value !== null);

  if (values.length === 0) {
    throw new ObservedDataError("Target column has no numeric or binary values");
  }
  const missingCount = rows.length - values.length;

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const median = percentile(sorted, 50);
  const ciLow = percentile(sorted, 2.5);
  const ciHigh = percentile(sorted, 97.5);
  const inferredThreshold =
    threshold !== null && threshold !== undefined && Number.isFinite(threshold)
      ? threshold
      : isBinary(values)
        ? 0.5
        : undefined;
  const pAboveThreshold =
    inferredThreshold === undefined
      ? 0
      : values.filter((value) => value > inferredThreshold).length / values.length;

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sd = sampleSd(values, mean);
  const range: [number, number] = min === max ? [min - 1, max + 1] : [min, max];
  const narration = [
    `Observed-data analysis of ${values.length.toLocaleString()} records from column "${targetColumn}".`,
    missingCount > 0
      ? `${missingCount.toLocaleString()} row${missingCount === 1 ? "" : "s"} had no usable target value.`
      : "No target values were missing.",
    `Mean ${formatNumber(mean)}, median ${formatNumber(median)}, empirical 95% interval [${formatNumber(ciLow)}, ${formatNumber(ciHigh)}].`,
    inferredThreshold === undefined
      ? "No threshold was supplied; calibration can use the observed mean only when it represents a probability."
      : `Observed share above threshold ${formatNumber(inferredThreshold)} is ${(pAboveThreshold * 100).toFixed(1)}%.`,
  ].join(" ");

  const graph: UncertaintyGraph = {
    analysisMode: "observed",
    nodes: [
      {
        id: "observed_values",
        name: "Observed Values",
        description: `${values.length} real records from ${targetColumn}`,
        distribution: "normal",
        mean,
        sd: Math.max(sd, Number.EPSILON),
        range,
        unit: targetColumn,
      },
      {
        id: "empirical_summary",
        name: "Empirical Summary",
        description: "Summary computed directly from observed rows",
        distribution: "normal",
        mean,
        sd: Math.max(sd, Number.EPSILON),
        range,
        unit: targetColumn,
      },
    ],
    edges: [
      {
        id: "observed_to_summary",
        source: "observed_values",
        target: "empirical_summary",
        method: "additive",
        label: "summarized from observed rows",
      },
    ],
    outputNodeId: "empirical_summary",
    threshold: inferredThreshold,
    narration,
  };

  return {
    graph,
    result: {
      samples: values,
      mean,
      median,
      ciLow,
      ciHigh,
      pAboveThreshold,
      seed: 0,
      nodeSamples: { observed_values: values },
    },
    sensitivity: [],
    narration,
    targetColumn,
    rowCount: values.length,
    totalRows: rows.length,
    missingCount,
  };
}

function parseObservedValue(value: string | undefined, rowNumber: number): number | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "happened"].includes(normalized)) return 1;
  if (["false", "no", "n", "did not happen", "didn't happen"].includes(normalized)) {
    return 0;
  }

  const numeric = Number(normalized.replace(/%$/, ""));
  if (!Number.isFinite(numeric)) {
    throw new ObservedDataError(`Row ${rowNumber} target value is not numeric or binary`);
  }
  return value.trim().endsWith("%") ? numeric / 100 : numeric;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sampleSd(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function isBinary(values: number[]) {
  return values.every((value) => value === 0 || value === 1);
}

function formatNumber(value: number) {
  if (Math.abs(value) >= 1) return value.toFixed(3);
  return value.toFixed(4);
}
