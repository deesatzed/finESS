/**
 * Semantic Mode — Phase B7: Expert Panel research mechanism.
 *
 * Operationalizes Principle 2 ("expert disagreement IS variance, not
 * error") in the most direct form available: the user types 2-N point
 * estimates per component, and we compute a distribution directly from
 * the panel's disagreement. NO LLM call, NO web call, NO RAG, NO
 * external dependency — this mechanism is purely deterministic
 * statistics over user-supplied numbers. That makes it the canonical
 * "I already polled the experts" research path, and the regression
 * baseline against which the LLM/web/RAG mechanisms can be sanity-
 * checked.
 *
 * Design decisions (recorded so reviewers do not re-derive them):
 *
 *  1. SYNCHRONOUS. There is no I/O. Returning a Promise would imply
 *     network or async cost that does not exist; callers should treat
 *     this as a pure stat transform. The contract is intentionally
 *     different from B1-B5 which all wrap LLM/HTTP calls.
 *
 *  2. SAMPLE standard deviation (n-1 denominator), not population.
 *     With "experts" we are estimating the spread of a wider expert
 *     population from a finite sample; Bessel's correction is the
 *     honest choice. Two experts with values 10 and 30 produce
 *     sd ≈ 14.14 (not 10), reflecting the genuine uncertainty about
 *     where the true centre sits.
 *
 *  3. DEGENERATE_PANEL when sd === 0. A panel that perfectly agrees is
 *     a load-bearing signal: either the question is so easy nobody
 *     disagrees (use `fixed` or `uniform` with a narrow band) OR the
 *     panel is captured / not independent. Either way the appropriate
 *     response is human inspection, not silently emitting a Normal
 *     with sd=0 (which would crash the Monte Carlo with division-by-
 *     variance downstream). Per Principle 6, an honest error is better
 *     than a misleading distribution.
 *
 *  4. Cap at 50 estimates. Beyond ~50 this is no longer an "expert
 *     panel"; it is empirical data, and the user should use Real Data
 *     Mode (B5b) which does proper KDE / empirical-CDF fitting. The
 *     cap is a guardrail against UI misuse, not a statistical limit.
 *
 *  5. Distribution selection precedence: `opts.distribution` >
 *     `opts.component.suggestedDistribution` > `"normal"`. The user's
 *     explicit override always wins; the LLM's suggestion from
 *     component-proposal is honored next; "normal" is the final
 *     fallback because it is the only distribution that places no
 *     constraints on the estimate values themselves.
 *
 *  6. UNSUPPORTED_DISTRIBUTION names the offending index so the UI can
 *     highlight which expert's estimate broke the assumption (e.g.
 *     beta requires all estimates in [0, 1]; if expert #3 says 1.2,
 *     the user needs to either change distribution or fix that entry).
 *
 *  7. Lognormal params are computed by transforming estimates to
 *     ln(x) and fitting the underlying Normal in log-space. This is
 *     the natural parameterization of Lognormal and matches what
 *     `sampleDistribution` (lib/engine/distributions.ts) reconstructs
 *     internally from mean/sd. We surface the raw mean/sd in the
 *     bundle params so the UI displays values consistent with the
 *     panel summary; the reasoning string captures the log-space fit.
 *
 *  8. Reasoning string and citations both list every estimate
 *     verbatim. Provenance is non-negotiable (plan principle 4); the
 *     user must always be able to reconstruct the panel from the
 *     bundle alone.
 *
 *  9. `ResearchBundle` in `lib/semantic/types.ts` does not yet declare
 *     a `citations` field — the comment notes that Phase B mechanisms
 *     add it per-bundle. We therefore declare an extended local type
 *     `ExpertPanelBundle` that adds `citations` and return that as the
 *     bundle. Downstream consumers that read `citations` should narrow
 *     to the per-mechanism extension; this avoids touching the shared
 *     types module per the file-ownership rules for parallel agents.
 */

import { getBetaParams } from "@/lib/engine/distributions";
import type {
  ProposedComponent,
  ProposedParams,
  ResearchBundle,
  SemanticDistribution,
} from "@/lib/semantic/types";

// The plan contract names this `DistributionType`; the semantic types
// module exports the same concept as `SemanticDistribution`. Alias
// here so the public contract matches the plan exactly without
// touching the types module.
export type DistributionType = SemanticDistribution;

/**
 * A single citation pinning a bundle to a specific source. For Expert
 * Panel, one citation per estimate; `source` is the label (or
 * `expert-N`) and `snippet` is the estimate value as a string.
 */
export interface ExpertPanelCitation {
  source: string;
  snippet: string;
}

/**
 * `ResearchBundle` extended with `citations`. See decision #9 above.
 */
export type ExpertPanelBundle = ResearchBundle & {
  citations: ExpertPanelCitation[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExpertPanelOptions {
  component: ProposedComponent;
  /** 2-N point estimates from independent expert opinions. Order does not matter. */
  estimates: number[];
  /** Override the distribution family the panel produces. Defaults to component.suggestedDistribution. */
  distribution?: DistributionType;
  /** Optional human-readable label per estimate (same order as estimates). UI provides this when available. */
  labels?: string[];
  /** When distribution === "uniform" or "triangular", caller may supply hard bounds; otherwise computed from estimates. */
  hardBounds?: { min: number; max: number };
}

export interface ExpertPanelRawStatistics {
  n: number;
  mean: number;
  /** Sample standard deviation (n-1 denominator). */
  sd: number;
  min: number;
  max: number;
  median: number;
}

export interface ExpertPanelResult {
  bundle: ExpertPanelBundle;
  rawStatistics: ExpertPanelRawStatistics;
}

export type ExpertPanelErrorCode =
  | "TOO_FEW_ESTIMATES"
  | "TOO_MANY_ESTIMATES"
  | "NON_FINITE_ESTIMATE"
  | "DEGENERATE_PANEL"
  | "UNSUPPORTED_DISTRIBUTION";

export class ExpertPanelError extends Error {
  readonly code: ExpertPanelErrorCode;

  constructor(message: string, code: ExpertPanelErrorCode) {
    super(message);
    this.name = "ExpertPanelError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ESTIMATES = 2;
const MAX_ESTIMATES = 50;

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Compute n, mean, sample-sd, min, max, median over a finite-validated
 * array. Caller MUST have validated values first; this helper is
 * intentionally minimal and trusts its inputs.
 */
function computeStatistics(values: number[]): ExpertPanelRawStatistics {
  const n = values.length;
  let sum = 0;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;

  // Sample variance with Bessel's correction (n-1 denominator).
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  const variance = n > 1 ? sumSq / (n - 1) : 0;
  const sd = Math.sqrt(variance);

  // Median: do not mutate the caller's array.
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return { n, mean, sd, min, max, median };
}

// ---------------------------------------------------------------------------
// Per-distribution param translators
// ---------------------------------------------------------------------------

interface TranslationContext {
  estimates: number[];
  stats: ExpertPanelRawStatistics;
  hardBounds?: { min: number; max: number };
}

function paramsForNormal(ctx: TranslationContext): ProposedParams {
  // sd === 0 already caught upstream by DEGENERATE_PANEL.
  return { mean: ctx.stats.mean, sd: ctx.stats.sd };
}

function paramsForLognormal(ctx: TranslationContext): ProposedParams {
  for (let i = 0; i < ctx.estimates.length; i++) {
    if (ctx.estimates[i] <= 0) {
      throw new ExpertPanelError(
        `lognormal distribution requires all estimates > 0; estimate at index ${i} is ${ctx.estimates[i]}`,
        "UNSUPPORTED_DISTRIBUTION",
      );
    }
  }
  const logs = ctx.estimates.map((v) => Math.log(v));
  const logStats = computeStatistics(logs);
  if (logStats.sd === 0) {
    // Defensive: if raw sd > 0 we should also have log sd > 0, but
    // guard against numerical edge cases.
    throw new ExpertPanelError(
      "lognormal sample collapses to zero variance in log-space",
      "DEGENERATE_PANEL",
    );
  }
  // Bundle exposes raw mean/sd so display layers stay consistent with
  // the panel summary; engine sampling internally converts back to
  // mu/sigma in log-space (see sampleDistribution case "lognormal").
  return { mean: ctx.stats.mean, sd: ctx.stats.sd };
}

function paramsForBeta(ctx: TranslationContext): ProposedParams {
  for (let i = 0; i < ctx.estimates.length; i++) {
    const v = ctx.estimates[i];
    if (v < 0 || v > 1) {
      throw new ExpertPanelError(
        `beta distribution requires all estimates in [0, 1]; estimate at index ${i} is ${v}`,
        "UNSUPPORTED_DISTRIBUTION",
      );
    }
  }
  const { alpha, beta } = getBetaParams(ctx.stats.mean, ctx.stats.sd);
  return {
    mean: ctx.stats.mean,
    sd: ctx.stats.sd,
    alpha,
    beta,
  };
}

function paramsForUniform(ctx: TranslationContext): ProposedParams {
  const min = ctx.hardBounds?.min ?? ctx.stats.min;
  const max = ctx.hardBounds?.max ?? ctx.stats.max;
  if (min === max) {
    throw new ExpertPanelError(
      `uniform distribution requires min !== max; got min=${min} max=${max}`,
      "UNSUPPORTED_DISTRIBUTION",
    );
  }
  if (min > max) {
    throw new ExpertPanelError(
      `uniform distribution requires min <= max; got min=${min} max=${max}`,
      "UNSUPPORTED_DISTRIBUTION",
    );
  }
  return { min, max };
}

function paramsForTriangular(ctx: TranslationContext): ProposedParams {
  const min = ctx.hardBounds?.min ?? ctx.stats.min;
  const max = ctx.hardBounds?.max ?? ctx.stats.max;
  const mode = ctx.stats.median;
  if (min === max) {
    throw new ExpertPanelError(
      `triangular distribution requires min !== max; got min=${min} max=${max}`,
      "UNSUPPORTED_DISTRIBUTION",
    );
  }
  if (min > max) {
    throw new ExpertPanelError(
      `triangular distribution requires min <= max; got min=${min} max=${max}`,
      "UNSUPPORTED_DISTRIBUTION",
    );
  }
  if (mode < min || mode > max) {
    // Can happen when hardBounds are narrower than the panel's spread.
    // Surface clearly rather than silently clamping the mode.
    throw new ExpertPanelError(
      `triangular distribution requires min <= mode <= max; got min=${min} mode=${mode} max=${max} (hardBounds may be narrower than the panel's median)`,
      "UNSUPPORTED_DISTRIBUTION",
    );
  }
  return { min, mode, max };
}

function translateParams(
  distribution: DistributionType,
  ctx: TranslationContext,
): ProposedParams {
  switch (distribution) {
    case "normal":
      return paramsForNormal(ctx);
    case "lognormal":
      return paramsForLognormal(ctx);
    case "beta":
      return paramsForBeta(ctx);
    case "uniform":
      return paramsForUniform(ctx);
    case "triangular":
      return paramsForTriangular(ctx);
    default: {
      // Exhaustiveness: TypeScript should prevent this, but guard at
      // runtime so a future addition to SemanticDistribution does not
      // silently fall through.
      const exhaustive: never = distribution;
      throw new ExpertPanelError(
        `unsupported distribution: ${String(exhaustive)}`,
        "UNSUPPORTED_DISTRIBUTION",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reasoning + citations
// ---------------------------------------------------------------------------

function buildReasoning(
  stats: ExpertPanelRawStatistics,
  estimates: number[],
): string {
  return `Expert panel of ${stats.n} estimates: ${estimates.join(
    ", ",
  )}. Mean ${stats.mean.toFixed(3)}, SD ${stats.sd.toFixed(
    3,
  )}, range [${stats.min.toFixed(3)}, ${stats.max.toFixed(
    3,
  )}]. Distribution derived from disagreement per Principle 2.`;
}

function buildCitations(
  estimates: number[],
  labels: string[] | undefined,
): ExpertPanelCitation[] {
  return estimates.map((est, i) => ({
    source: labels?.[i] ?? `expert-${i + 1}`,
    snippet: String(est),
  }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateEstimates(estimates: number[]): void {
  if (!Array.isArray(estimates)) {
    throw new ExpertPanelError(
      `estimates must be an array; got ${typeof estimates}`,
      "TOO_FEW_ESTIMATES",
    );
  }
  if (estimates.length < MIN_ESTIMATES) {
    throw new ExpertPanelError(
      `expert panel requires at least ${MIN_ESTIMATES} estimates; got ${estimates.length}`,
      "TOO_FEW_ESTIMATES",
    );
  }
  if (estimates.length > MAX_ESTIMATES) {
    throw new ExpertPanelError(
      `expert panel accepts at most ${MAX_ESTIMATES} estimates (use Real Data Mode for larger samples); got ${estimates.length}`,
      "TOO_MANY_ESTIMATES",
    );
  }
  for (let i = 0; i < estimates.length; i++) {
    const v = estimates[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ExpertPanelError(
        `estimate at index ${i} is not a finite number; got ${String(v)}`,
        "NON_FINITE_ESTIMATE",
      );
    }
  }
}

function pickDistribution(opts: ExpertPanelOptions): DistributionType {
  if (opts.distribution !== undefined) return opts.distribution;
  if (opts.component.suggestedDistribution !== undefined) {
    return opts.component.suggestedDistribution;
  }
  return "normal";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build a research bundle from an expert panel of 2-N point estimates.
 *
 * Synchronous: no I/O of any kind. The "research" is the statistical
 * translation of disagreement into a distribution per Principle 2.
 *
 * Throws `ExpertPanelError` for every validation failure, with a code
 * the UI can branch on to provide actionable guidance.
 */
export function researchExpertPanel(
  opts: ExpertPanelOptions,
): ExpertPanelResult {
  validateEstimates(opts.estimates);

  const stats = computeStatistics(opts.estimates);

  // Panel agreement is itself a finding worth surfacing — refuse to
  // emit a zero-variance distribution that would mislead downstream
  // Monte Carlo / display.
  if (stats.sd === 0) {
    throw new ExpertPanelError(
      `expert panel is degenerate: all ${stats.n} estimates equal ${stats.mean}. Pick "uniform" with explicit bounds or treat as a fixed value.`,
      "DEGENERATE_PANEL",
    );
  }

  const distribution = pickDistribution(opts);
  const params = translateParams(distribution, {
    estimates: opts.estimates,
    stats,
    hardBounds: opts.hardBounds,
  });

  const bundle: ExpertPanelBundle = {
    componentId: opts.component.id,
    mechanism: "expert_panel",
    proposedDistribution: distribution,
    proposedParams: params,
    reasoning: buildReasoning(stats, opts.estimates),
    citations: buildCitations(opts.estimates, opts.labels),
  };

  return { bundle, rawStatistics: stats };
}
