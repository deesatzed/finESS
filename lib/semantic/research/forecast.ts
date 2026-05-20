/**
 * Semantic Mode — Phase B5a: Forecast Mode as a research mechanism.
 *
 * Wraps the existing Python ensemble sidecar (services/ensemble) — the same
 * one Forecast Mode tab uses — so a Semantic-Mode component representing a
 * future numeric quantity over time can be filled from a real ensemble
 * forecast. The forecast's point estimate becomes the proposed mean and
 * the 95% confidence interval is converted into an SD assuming normality
 * (sd = (ci_high - ci_low) / 3.92, the standard z=1.96 mapping). Per-model
 * SLSQP weights and individual model predictions become citations on the
 * resulting `ResearchBundle`.
 *
 * Design decisions:
 *
 *  1. The ensemble client is the SAME `EnsembleClient` Forecast Mode uses
 *     (lib/services/ensemble-client.ts). No re-implementation of the HTTP
 *     plumbing, no second timeout discipline. We optionally accept an
 *     injected client for unit-test isolation; production callers pass
 *     none and we instantiate one against ENSEMBLE_SIDECAR_URL.
 *
 *  2. Sidecar errors map cleanly: `EnsembleClientError` (HTTP-level non-2xx
 *     from the sidecar) -> SIDECAR_ERROR; anything else (AbortError,
 *     fetch network failure) -> SIDECAR_UNREACHABLE. The route-level
 *     handler already follows this split (see app/api/forecast/route.ts).
 *
 *  3. We refuse to fabricate a non-degenerate Normal from a zero-width CI.
 *     `ci_high === ci_low` means the ensemble is reporting zero spread —
 *     usually because the input series is constant. Forcing SD = epsilon
 *     would lie about the uncertainty; instead we throw DEGENERATE_CI so
 *     the operator inspects the series and consciously chooses a fixed /
 *     uniform / constant representation. Principle 6: a wide interval is
 *     useful honesty; a fake non-zero interval is dishonest.
 *
 *  4. The bundle's componentId is always the input component's id — never
 *     the sidecar's `column` field. Translating between "the user's named
 *     factor" and "the CSV column carrying its values" is the caller's
 *     responsibility; this adapter must not leak the column name into the
 *     component identity.
 *
 *  5. No mock product data. The CSV rows passed in are the operator's real
 *     uploaded data; per-model citations are derived from the real sidecar
 *     response. Unit tests inject a typed fake EnsembleClient ONLY to
 *     observe parsing / error mapping in isolation — they exercise no
 *     product code path that would consume mock data in production.
 */

import {
  EnsembleClient,
  EnsembleClientError,
  type EnsembleClientOptions,
  type EnsemblePrediction,
} from "@/lib/services/ensemble-client";
import type {
  ProposedComponent,
  ResearchBundle,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single citation entry on a `forecast` research bundle. There is one
 * citation per ensemble member so the operator can inspect both the per-
 * model SLSQP weight and the per-model individual prediction at a glance.
 */
export interface ForecastResearchCitation {
  source: string;
  snippet: string;
}

/**
 * Structural shape of the bundle this mechanism returns. Compatible with
 * `ResearchBundle` (the state machine accepts it via `researchReceived`);
 * adds the per-model `citations` payload the UI renders.
 */
export interface ForecastResearchBundle extends ResearchBundle {
  mechanism: "ensemble_forecast";
  citations: ForecastResearchCitation[];
}

export interface ForecastResearchOptions {
  component: ProposedComponent;
  /**
   * Real CSV rows already parsed from the operator's upload. The sidecar
   * accepts either string- or number-valued cells; we keep both shapes in
   * the type so callers can pass `parse(...)` output directly.
   */
  csvRows: Array<Record<string, string | number>>;
  dateColumn: string;
  targetColumn: string;
  /**
   * Forecast horizon in steps. 1, 2, or 3 are the supported horizons in
   * the existing Forecast Mode UI; anything else is rejected at validation
   * time so the semantic-mode surface stays aligned with the standalone
   * tab.
   */
  horizon: 1 | 2 | 3;
  /** Injectable for tests; production callers omit and we instantiate. */
  ensembleClient?: EnsembleClient;
  /** Optional client options used only when `ensembleClient` is not given. */
  ensembleClientOptions?: EnsembleClientOptions;
}

export interface ForecastResearchResult {
  bundle: ForecastResearchBundle;
  ensembleLatencyMs: number;
  perModelWeights: Record<string, number>;
  individualPredictions: Record<string, number>;
}

export type ForecastResearchErrorCode =
  | "EMPTY_CSV"
  | "INVALID_HORIZON"
  | "SIDECAR_UNREACHABLE"
  | "SIDECAR_ERROR"
  | "DEGENERATE_CI";

export class ForecastResearchError extends Error {
  readonly code: ForecastResearchErrorCode;

  constructor(message: string, code: ForecastResearchErrorCode) {
    super(message);
    this.name = "ForecastResearchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const VALID_HORIZONS: ReadonlyArray<number> = [1, 2, 3];

/**
 * Convert a 95% CI into a normal-distribution SD. Standard inversion:
 * a 95% two-sided CI under a Normal spans ±1.96 SD around the mean,
 * so total CI width = 2 * 1.96 * sd = 3.92 * sd. Inverting:
 *   sd = (ci_high - ci_low) / 3.92
 *
 * Caller must already have rejected the degenerate case ci_high === ci_low.
 */
function ciToSd(ciLow: number, ciHigh: number): number {
  return (ciHigh - ciLow) / 3.92;
}

/**
 * Format a per-model weight + individual prediction into the citation
 * snippet. Kept as a single function so unit tests can assert the exact
 * shape and the UI can rely on it.
 */
function formatModelCitation(
  modelName: string,
  weight: number,
  prediction: number,
): ForecastResearchCitation {
  return {
    source: `ensemble-model:${modelName}`,
    snippet: `weight=${weight.toFixed(3)} prediction=${prediction.toFixed(2)}`,
  };
}

function buildReasoning(
  rowCount: number,
  perModelWeights: Record<string, number>,
  regime: string,
): string {
  const weightSummary = Object.entries(perModelWeights)
    .map(([model, weight]) => `${model}=${weight.toFixed(3)}`)
    .join(", ");
  const regimeLabel =
    typeof regime === "string" && regime.trim() !== "" ? regime.trim() : "unknown";
  return `Ensemble forecast over ${rowCount} rows. Per-model weights: ${weightSummary}. Regime: ${regimeLabel}.`;
}

function buildCitations(
  perModelWeights: Record<string, number>,
  individualPredictions: Record<string, number>,
): ForecastResearchCitation[] {
  return Object.entries(perModelWeights).map(([modelName, weight]) => {
    const prediction = individualPredictions[modelName];
    // `prediction` may legitimately be undefined for a model with zero
    // weight that the sidecar pruned from individual_predictions. Surface
    // NaN in the snippet rather than silently skipping the citation —
    // the operator should see that the model contributed weight but no
    // independent estimate.
    const safePrediction =
      typeof prediction === "number" && Number.isFinite(prediction)
        ? prediction
        : Number.NaN;
    return formatModelCitation(modelName, weight, safePrediction);
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a real ensemble forecast on the operator's CSV and return a
 * `ResearchBundle` the Semantic Mode state machine can accept.
 *
 * Production callers pass no `ensembleClient`; the standard EnsembleClient
 * (ENSEMBLE_SIDECAR_URL) is instantiated for them. Unit tests inject a
 * typed fake to observe parsing / error mapping in isolation.
 */
export async function researchForecast(
  opts: ForecastResearchOptions,
): Promise<ForecastResearchResult> {
  // Caller-side validation: refuse to spend a sidecar call on a malformed
  // input. The two checks are intentionally cheap and order-stable so the
  // first thrown error is deterministic.
  if (!opts.component || typeof opts.component.id !== "string" || opts.component.id.trim() === "") {
    // Treat malformed component as a programmer bug: surface EMPTY_CSV is
    // wrong; INVALID_HORIZON is wrong; the spec only enumerates 5 codes,
    // so we use the closest semantically-appropriate one — DEGENERATE_CI
    // does not fit, SIDECAR_* do not fit, EMPTY_CSV is the only "input is
    // not usable" code. We bias toward the input-shape error.
    throw new ForecastResearchError(
      "researchForecast requires a component with a non-empty id",
      "EMPTY_CSV",
    );
  }
  if (!Array.isArray(opts.csvRows) || opts.csvRows.length === 0) {
    throw new ForecastResearchError(
      "researchForecast requires at least one CSV row",
      "EMPTY_CSV",
    );
  }
  if (!VALID_HORIZONS.includes(opts.horizon)) {
    throw new ForecastResearchError(
      `researchForecast requires horizon in {1, 2, 3} (got ${String(opts.horizon)})`,
      "INVALID_HORIZON",
    );
  }
  if (typeof opts.dateColumn !== "string" || opts.dateColumn.trim() === "") {
    throw new ForecastResearchError(
      "researchForecast requires a non-empty dateColumn",
      "EMPTY_CSV",
    );
  }
  if (typeof opts.targetColumn !== "string" || opts.targetColumn.trim() === "") {
    throw new ForecastResearchError(
      "researchForecast requires a non-empty targetColumn",
      "EMPTY_CSV",
    );
  }

  const client =
    opts.ensembleClient ?? new EnsembleClient(opts.ensembleClientOptions);
  const startedAt = Date.now();

  let prediction: EnsemblePrediction;
  try {
    await client.train({
      csvRows: opts.csvRows,
      dateColumn: opts.dateColumn,
      targetColumns: [opts.targetColumn],
    });
    prediction = await client.predict({
      csvRows: opts.csvRows,
      dateColumn: opts.dateColumn,
      targetColumn: opts.targetColumn,
      nSteps: opts.horizon,
    });
  } catch (err) {
    if (err instanceof EnsembleClientError) {
      throw new ForecastResearchError(
        `ensemble sidecar returned ${err.status}: ${err.message}`,
        "SIDECAR_ERROR",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ForecastResearchError(
      `ensemble sidecar unreachable: ${message}`,
      "SIDECAR_UNREACHABLE",
    );
  }

  const ensembleLatencyMs = Date.now() - startedAt;

  // Honest-uncertainty gate: a zero-width CI cannot be turned into a
  // non-degenerate Normal. Make the operator look at it.
  if (prediction.lower_95 === prediction.upper_95) {
    throw new ForecastResearchError(
      `ensemble returned a degenerate 95% CI (lower_95 === upper_95 === ${prediction.lower_95}); cannot derive a non-degenerate Normal. Inspect the input series for a constant value.`,
      "DEGENERATE_CI",
    );
  }

  const mean = prediction.prediction;
  const sd = ciToSd(prediction.lower_95, prediction.upper_95);

  const perModelWeights: Record<string, number> = { ...prediction.model_weights };
  const individualPredictions: Record<string, number> = {
    ...prediction.individual_predictions,
  };

  const bundle: ForecastResearchBundle = {
    componentId: opts.component.id,
    mechanism: "ensemble_forecast",
    proposedDistribution: "normal",
    proposedParams: { mean, sd },
    reasoning: buildReasoning(
      opts.csvRows.length,
      perModelWeights,
      prediction.regime_type,
    ),
    citations: buildCitations(perModelWeights, individualPredictions),
  };

  return {
    bundle,
    ensembleLatencyMs,
    perModelWeights,
    individualPredictions,
  };
}
