/**
 * Semantic Mode — Phase B5b: Real Data Mode as a research mechanism.
 *
 * Wraps the existing empirical analyzer (`lib/real-data/analyze.ts`) — the
 * same one Real Data Mode tab uses — so a Semantic-Mode component
 * representing a measured empirical quantity from a CSV can be filled
 * directly from the observed-data distribution. The empirical mean +
 * sample SD become the proposed Normal parameters; row counts, missing
 * counts, and the empirical 95% interval ride as the citation snippet.
 *
 * Design decisions:
 *
 *  1. We reuse `analyzeObservedRows` directly. Its signature is
 *     `(rows: Record<string, string>[], targetColumn: string, threshold?: number | null) => ObservedAnalysisResult`
 *     so we coerce inbound numeric cells to strings on the way in (the
 *     analyzer's `parseObservedValue` parses strings -> numbers internally
 *     and is the source of truth for what counts as a usable value). No
 *     re-implementation of the mean/sd computation here — that lives in
 *     the analyzer and we keep it as the single source of truth.
 *
 *  2. Translation to a Normal distribution uses the SD already computed
 *     by the analyzer: it builds the empirical-summary node with
 *     `sd = Math.max(sampleSd, Number.EPSILON)`. We can therefore reach
 *     the SD via the resulting `graph.nodes` entry — but we also keep an
 *     explicit guard for the degenerate case (sample SD === 0 from a
 *     constant column) so we never quietly hand the engine a Normal with
 *     SD = EPSILON pretending to be uncertainty. Principle 6: be honest
 *     about constants.
 *
 *  3. The bundle's componentId is always the input component's id — never
 *     the CSV column name. Translating between "the user's named factor"
 *     and "the CSV column carrying its values" is the caller's concern.
 *
 *  4. Error mapping:
 *       - Empty input rows                       -> EMPTY_CSV
 *       - All rows missing the target column     -> ALL_MISSING
 *       - SD = 0 (constant column)               -> DEGENERATE_DISTRIBUTION
 *       The underlying `ObservedDataError` has three message-only flavors
 *       (no row, no target, no numeric/binary values). We distinguish
 *       them by message so the caller gets a typed code, not a generic
 *       'analysis failed'. The analyzer's exact messages are stable
 *       (see `lib/real-data/analyze.ts`); a string-match break is
 *       caught by the unit tests.
 *
 *  5. No mock product data. CSV rows passed in are the operator's real
 *     uploaded data. Tests use tiny fixed real rows (constant-column,
 *     numeric, missing) to exercise each branch; nothing is fabricated.
 */

import {
  analyzeObservedRows,
  ObservedDataError,
  type ObservedAnalysisResult,
} from "@/lib/real-data/analyze";
import type {
  ProposedComponent,
  ResearchBundle,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmpiricalResearchCitation {
  source: string;
  snippet: string;
}

export interface EmpiricalResearchBundle extends ResearchBundle {
  mechanism: "empirical_observation";
  citations: EmpiricalResearchCitation[];
}

export interface EmpiricalResearchOptions {
  component: ProposedComponent;
  /**
   * Real CSV rows already parsed from the operator's upload. Cells may be
   * strings (raw CSV) or numbers (already coerced); we normalize to
   * strings on the way into the analyzer.
   */
  csvRows: Array<Record<string, string | number>>;
  targetColumn: string;
  /**
   * Optional threshold passthrough to the empirical analyzer. Not used to
   * build the bundle but kept on the options surface so the same call
   * site can compute p_above_threshold for downstream UI if needed later.
   */
  threshold?: number | null;
}

export interface EmpiricalResearchResult {
  bundle: EmpiricalResearchBundle;
  rowCount: number;
  missingCount: number;
}

export type EmpiricalResearchErrorCode =
  | "EMPTY_CSV"
  | "ALL_MISSING"
  | "DEGENERATE_DISTRIBUTION";

export class EmpiricalResearchError extends Error {
  readonly code: EmpiricalResearchErrorCode;

  constructor(message: string, code: EmpiricalResearchErrorCode) {
    super(message);
    this.name = "EmpiricalResearchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Normalize a heterogeneous row of strings-or-numbers into the
 * string-only shape `analyzeObservedRows` accepts. We stringify each
 * number with `String(...)` so the analyzer's own parser
 * (`parseObservedValue`) is the single source of truth for what counts
 * as usable. Booleans and other non-string-non-number cells are left
 * empty so the analyzer treats them as missing.
 */
function normalizeRows(
  rows: Array<Record<string, string | number>>,
): Record<string, string>[] {
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === "number") {
        out[key] = Number.isFinite(value) ? String(value) : "";
      } else if (typeof value === "string") {
        out[key] = value;
      } else {
        out[key] = "";
      }
    }
    return out;
  });
}

/**
 * Reach into the analyzer's output to grab the empirical SD it computed.
 * The analyzer builds an `empirical_summary` node with the SD already
 * floored at Number.EPSILON; we read it back rather than recomputing so
 * the two surfaces (Real Data tab + Semantic Mode B5b) never disagree.
 *
 * Returns NaN if the node is unexpectedly absent — caller treats that
 * as a degenerate signal rather than silently substituting zero.
 */
function readSdFromAnalysis(analysis: ObservedAnalysisResult): number {
  const node = analysis.graph.nodes.find((n) => n.id === "empirical_summary");
  if (!node || typeof node.sd !== "number" || !Number.isFinite(node.sd)) {
    return Number.NaN;
  }
  return node.sd;
}

/**
 * Map the underlying ObservedDataError into a typed EmpiricalResearchError.
 * The analyzer's exact messages are listed below; if they change, the
 * test `it maps no-numeric-values to ALL_MISSING` will catch the drift.
 */
function mapObservedError(err: ObservedDataError): EmpiricalResearchError {
  const msg = err.message;
  if (/at least one row/i.test(msg)) {
    return new EmpiricalResearchError(
      `empirical analyzer rejected input: ${msg}`,
      "EMPTY_CSV",
    );
  }
  if (/no numeric or binary values/i.test(msg)) {
    return new EmpiricalResearchError(
      `empirical analyzer rejected input: ${msg}`,
      "ALL_MISSING",
    );
  }
  // Any other ObservedDataError (e.g. "Select a target column", "Row N
  // target value is not numeric or binary") is a caller-shape problem;
  // surface as EMPTY_CSV so the caller treats it as an input-validation
  // failure rather than a research mechanism failure.
  return new EmpiricalResearchError(
    `empirical analyzer rejected input: ${msg}`,
    "EMPTY_CSV",
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function researchEmpirical(
  opts: EmpiricalResearchOptions,
): Promise<EmpiricalResearchResult> {
  if (
    !opts.component ||
    typeof opts.component.id !== "string" ||
    opts.component.id.trim() === ""
  ) {
    throw new EmpiricalResearchError(
      "researchEmpirical requires a component with a non-empty id",
      "EMPTY_CSV",
    );
  }
  if (!Array.isArray(opts.csvRows) || opts.csvRows.length === 0) {
    throw new EmpiricalResearchError(
      "researchEmpirical requires at least one CSV row",
      "EMPTY_CSV",
    );
  }
  if (typeof opts.targetColumn !== "string" || opts.targetColumn.trim() === "") {
    throw new EmpiricalResearchError(
      "researchEmpirical requires a non-empty targetColumn",
      "EMPTY_CSV",
    );
  }

  const normalized = normalizeRows(opts.csvRows);

  // Pre-check: if every row's targetColumn is empty after normalization,
  // the analyzer would raise "no numeric or binary values"; we surface
  // ALL_MISSING directly so the operator's error message names the
  // right symptom even when there's NO numeric content at all (vs.
  // some-numeric but all-NaN, which the analyzer also flags).
  const hasAnyNonEmpty = normalized.some(
    (r) => r[opts.targetColumn] !== undefined && r[opts.targetColumn].trim() !== "",
  );
  if (!hasAnyNonEmpty) {
    throw new EmpiricalResearchError(
      `every row's "${opts.targetColumn}" cell is empty; cannot compute empirical distribution`,
      "ALL_MISSING",
    );
  }

  let analysis: ObservedAnalysisResult;
  try {
    analysis = analyzeObservedRows(normalized, opts.targetColumn, opts.threshold);
  } catch (err) {
    if (err instanceof ObservedDataError) {
      throw mapObservedError(err);
    }
    throw err;
  }

  const rowCount = analysis.rowCount;
  const missingCount = analysis.missingCount;
  const mean = analysis.result.mean;
  const ciLow = analysis.result.ciLow;
  const ciHigh = analysis.result.ciHigh;
  const sd = readSdFromAnalysis(analysis);

  if (!Number.isFinite(sd)) {
    throw new EmpiricalResearchError(
      `empirical analyzer did not return a usable SD for "${opts.targetColumn}"`,
      "DEGENERATE_DISTRIBUTION",
    );
  }

  // The analyzer floors the SD at Number.EPSILON to keep the engine from
  // dividing by zero; we treat anything at or below that floor as
  // genuinely-zero variance and refuse to pretend it's a meaningful
  // Normal. Operator should pick uniform / fixed.
  if (sd <= Number.EPSILON) {
    throw new EmpiricalResearchError(
      `target column "${opts.targetColumn}" has zero sample variance (constant value ${mean}); pick a uniform or fixed representation instead of Normal`,
      "DEGENERATE_DISTRIBUTION",
    );
  }

  const reasoning =
    `Empirical observation over ${rowCount} rows ` +
    `(${missingCount} missing for target "${opts.targetColumn}"). ` +
    `Distribution = Normal(${mean.toFixed(3)}, ${sd.toFixed(3)}). ` +
    `95% empirical interval [${ciLow.toFixed(3)}, ${ciHigh.toFixed(3)}].`;

  const citation: EmpiricalResearchCitation = {
    source: `csv:${opts.targetColumn}`,
    snippet:
      `rows=${rowCount} missing=${missingCount} ` +
      `mean=${mean.toFixed(3)} sd=${sd.toFixed(3)}`,
  };

  const bundle: EmpiricalResearchBundle = {
    componentId: opts.component.id,
    mechanism: "empirical_observation",
    proposedDistribution: "normal",
    proposedParams: { mean, sd },
    reasoning,
    citations: [citation],
  };

  return { bundle, rowCount, missingCount };
}
