/**
 * Semantic Mode — B4: Multi-LLM consensus research mechanism.
 *
 * Per component, fan out the same per-component-research prompt to N
 * configured LLMs in parallel (bounded concurrency, mirrors the worker
 * pool pattern in `lib/ai/multi-proposer.ts` — R6-02). Each model
 * returns its proposed distribution + parameters + reasoning. We
 * report:
 *
 *   (1) the N independent per-model proposals (with per-model error if
 *       that model failed — we DO NOT abort the batch on per-model
 *       failure; surfacing "model X couldn't even answer" IS the signal
 *       this lane exists for);
 *   (2) a synthesized "consensus" ResearchBundle computed by
 *       distribution-family vote then envelope-widening within the
 *       winning family (MIN-of-mins, MAX-of-maxes, MEAN-of-means,
 *       MAX-of-SDs — wider = more honest, Principle 6);
 *   (3) a rough disagreement score in [0, 1] computed from the central
 *       estimates of the successful bundles.
 *
 * Why we do NOT import the B1 (`llm-prior.ts`) prompt builder:
 *   B1 and B4 are parallel agents in Phase B Wave 1 and B1 may not
 *   have landed yet at the time this file is consumed. Inlining the
 *   equivalent prompt keeps this module self-contained. When B1 lands
 *   on `main` a follow-up commit can DRY the two prompts behind a
 *   shared builder; until then the duplication is the cheap price for
 *   parallel build-out.
 *
 * Critical workspace rules honored here:
 *   - No mock product data. Test-harness fetch fakes are labeled.
 *   - No model versions hardcoded. The caller supplies `models`.
 *   - Every LLM call goes through the centralized `callChat` wrapper
 *     so per-call timeout / single-retry / cost ceiling enforcement is
 *     uniform across the codebase.
 *
 * State machine integration:
 *   The returned `ConsensusResearchResult.consensus` is the
 *   `ResearchBundle` the caller dispatches via
 *   `researchReceived(componentId, bundle)`. The per-model proposals
 *   are intended for the per-component review UI so the user can see
 *   the underlying disagreement that the synthesized bundle averages
 *   over.
 */

import {
  callChat,
  OpenRouterCallError,
  type CallChatOptions,
} from "@/lib/ai/openrouter-client";
import type {
  ProposedComponent,
  ProposedParams,
  ResearchBundle,
  SemanticDistribution,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConsensusResearchOptions {
  component: ProposedComponent;
  query: string;
  clarifications?: Array<{
    question: { id: string; question: string };
    answer: string;
  }>;
  /** At least two model ids. Caller passes the configured set. */
  models: string[];
  apiKey: string;
  /** Default 3 (matches R6-02 DEFAULT_CONCURRENCY). */
  concurrencyLimit?: number;
  timeoutMs?: number;
  /** Per-call ceiling; total cost = N * this max. */
  costBudgetUsd?: number;
  /** Test-harness injection only; production code passes nothing. */
  fetchImpl?: CallChatOptions["fetchImpl"];
}

export interface ConsensusProposal {
  model: string;
  /** Present iff this model succeeded. */
  bundle?: ResearchBundle;
  /** Typed error message if this model failed. */
  error?: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export interface ConsensusResearchResult {
  /** One entry per model in input order (deterministic for UI). */
  proposals: ConsensusProposal[];
  /**
   * Synthesized consensus bundle from the SUCCESSFUL proposals.
   * Null if zero proposers succeeded (caller will see the error throw
   * before observing this; null is reserved for the future case where
   * we relax the throw).
   */
  consensus: ResearchBundle | null;
  /** 0 = perfect agreement; 1 = maximum disagreement. */
  disagreementScore: number;
  successCount: number;
  errorCount: number;
  totalCostUsd: number;
  wallTimeMs: number;
}

export type ConsensusResearchErrorCode =
  | "EMPTY_MODELS"
  | "ALL_PROPOSERS_FAILED";

export class ConsensusResearchError extends Error {
  readonly code: ConsensusResearchErrorCode;
  constructor(message: string, code: ConsensusResearchErrorCode) {
    super(message);
    this.name = "ConsensusResearchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TEMPERATURE = 0.4;

const VALID_DISTRIBUTIONS: ReadonlyArray<SemanticDistribution> = [
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
];

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for a per-component research call. Inlined
 * here (rather than importing from B1) so this module compiles
 * independently of B1 landing. See file header for rationale.
 */
export function buildConsensusSystemPrompt(): string {
  return `You are an expert uncertainty-modeling assistant for finESS.

For ONE specific component of a larger uncertainty model, propose a
probability distribution that captures its plausible range.

Distribution families you may use:
  beta       -> bounded probabilities or fractions in [0, 1].
                Required params: alpha (>0), beta (>0).
  normal     -> continuous, symmetric.
                Required params: mean (number), sd (>0).
  uniform    -> known min/max, no central tendency.
                Required params: min (number), max (>min).
  lognormal  -> positive, right-skewed (costs, durations, sizes).
                Required params: mean (>0) of the underlying log, sd (>0).
  triangular -> bounded with a known most-likely value (best/likely/worst).
                Required params: min (number), mode (number in [min, max]),
                max (>min).

Produce a 2-3 sentence reasoning string explaining:
  - WHY this distribution family fits this component.
  - WHY this central value is the best central estimate.
  - WHY this spread captures the plausible range (cite general
    knowledge / well-known datasets / textbook ranges if applicable).

Output strict JSON with exactly this shape and nothing else:
{
  "proposedDistribution": "beta" | "normal" | "uniform" | "lognormal" | "triangular",
  "proposedParams": {
    "mean": ..., "sd": ...,        // for normal / lognormal
    "alpha": ..., "beta": ...,     // for beta
    "min": ..., "max": ...,        // for uniform
    "min": ..., "mode": ..., "max": ...  // for triangular
  },
  "reasoning": "..."
}

Return ONLY the JSON object — no markdown fences, no prose before or after.`;
}

export function buildConsensusUserMessage(
  query: string,
  component: ProposedComponent,
  clarifications: ConsensusResearchOptions["clarifications"],
): string {
  const qaLines =
    clarifications && clarifications.length > 0
      ? clarifications
          .map((p) => `Q: ${p.question.question}\nA: ${p.answer}`)
          .join("\n\n")
      : "(no clarifying Q&A provided)";

  const dist = component.suggestedDistribution
    ? `Suggested distribution (you may override with explicit reasoning): ${component.suggestedDistribution}`
    : "No distribution suggestion was provided; pick the best fit.";

  return `Overall query:
${query}

Clarifying Q&A:
${qaLines}

Component to research:
  id: ${component.id}
  name: ${component.name}
  description: ${component.description}
  ${dist}
  ${component.why ? `why this component matters: ${component.why}` : ""}

Propose the distribution + params + reasoning for THIS component now.`;
}

// ---------------------------------------------------------------------------
// Per-model parsing / validation
// ---------------------------------------------------------------------------

function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }
  return cleaned;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate the per-model JSON response against the contract above and
 * coerce into a typed `ResearchBundle`. Throws an Error with a
 * descriptive message — the caller wraps it into a per-proposal `error`
 * string so the batch is not aborted.
 */
function parseAndValidateResponse(
  rawContent: string,
  componentId: string,
  model: string,
): ResearchBundle {
  const cleaned = stripMarkdownFences(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`PARSE_FAILED: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PARSE_FAILED: response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const dist = obj.proposedDistribution;
  if (typeof dist !== "string") {
    throw new Error("INVALID_RESPONSE: missing 'proposedDistribution'");
  }
  if (!(VALID_DISTRIBUTIONS as ReadonlyArray<string>).includes(dist)) {
    throw new Error(
      `INVALID_DISTRIBUTION: '${dist}' is not one of ${VALID_DISTRIBUTIONS.join(", ")}`,
    );
  }
  const distribution = dist as SemanticDistribution;

  const paramsRaw = obj.proposedParams;
  if (
    typeof paramsRaw !== "object" ||
    paramsRaw === null ||
    Array.isArray(paramsRaw)
  ) {
    throw new Error("INVALID_RESPONSE: missing or non-object 'proposedParams'");
  }
  const p = paramsRaw as Record<string, unknown>;

  // Pull out canonical keys we know about; reject the bundle if the
  // required-for-this-distribution keys are missing or non-finite.
  const proposedParams: ProposedParams = {};

  function requireNum(key: keyof ProposedParams, predicate?: (n: number) => boolean): void {
    const v = (p as Record<string, unknown>)[key as string];
    if (!isFiniteNumber(v)) {
      throw new Error(
        `INVALID_RESPONSE: ${distribution} requires finite numeric '${String(key)}'`,
      );
    }
    if (predicate && !predicate(v)) {
      throw new Error(
        `INVALID_RESPONSE: ${distribution} param '${String(key)}'=${v} failed validation`,
      );
    }
    (proposedParams as Record<string, number>)[key as string] = v;
  }

  switch (distribution) {
    case "normal":
    case "lognormal":
      requireNum("mean");
      requireNum("sd", (n) => n > 0);
      break;
    case "beta":
      requireNum("alpha", (n) => n > 0);
      requireNum("beta", (n) => n > 0);
      break;
    case "uniform":
      requireNum("min");
      requireNum("max");
      if ((proposedParams.max as number) <= (proposedParams.min as number)) {
        throw new Error("INVALID_RESPONSE: uniform requires max > min");
      }
      break;
    case "triangular":
      requireNum("min");
      requireNum("mode");
      requireNum("max");
      if ((proposedParams.max as number) <= (proposedParams.min as number)) {
        throw new Error("INVALID_RESPONSE: triangular requires max > min");
      }
      if (
        (proposedParams.mode as number) < (proposedParams.min as number) ||
        (proposedParams.mode as number) > (proposedParams.max as number)
      ) {
        throw new Error(
          "INVALID_RESPONSE: triangular requires min <= mode <= max",
        );
      }
      break;
  }

  const reasoningRaw = obj.reasoning;
  if (typeof reasoningRaw !== "string" || reasoningRaw.trim() === "") {
    throw new Error("INVALID_RESPONSE: missing non-empty 'reasoning'");
  }

  return {
    componentId,
    // Per-model bundle is tagged with this model's mechanism. The
    // synthesized consensus bundle overrides this with
    // "multi_llm_consensus".
    mechanism: "llm_prior",
    proposedDistribution: distribution,
    proposedParams,
    reasoning: `[${model}] ${reasoningRaw.trim()}`,
  };
}

// ---------------------------------------------------------------------------
// Per-model worker
// ---------------------------------------------------------------------------

function describeOpenRouterError(err: OpenRouterCallError): string {
  if (err.httpStatus !== undefined) {
    return `${err.code} HTTP ${err.httpStatus}`;
  }
  return err.code;
}

async function runOneProposer(
  model: string,
  opts: ConsensusResearchOptions,
): Promise<ConsensusProposal> {
  const startedAt = Date.now();
  let callResult;
  try {
    callResult = await callChat({
      model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: buildConsensusSystemPrompt() },
        {
          role: "user",
          content: buildConsensusUserMessage(
            opts.query,
            opts.component,
            opts.clarifications,
          ),
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic Multi-LLM Consensus",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      return {
        model,
        error: describeOpenRouterError(err),
        latencyMs: err.latencyMs ?? Date.now() - startedAt,
        costUsd: err.costUsd ?? 0,
        retryCount: 0,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      model,
      error: `UNKNOWN: ${message}`,
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      retryCount: 0,
    };
  }

  const { content, latencyMs, costUsd, retryCount } = callResult;
  if (!content || content.trim() === "") {
    return {
      model,
      error: "EMPTY_RESPONSE",
      latencyMs,
      costUsd,
      retryCount,
    };
  }

  try {
    const bundle = parseAndValidateResponse(content, opts.component.id, model);
    return { model, bundle, latencyMs, costUsd, retryCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      model,
      error: message,
      latencyMs,
      costUsd,
      retryCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Consensus synthesis
// ---------------------------------------------------------------------------

/**
 * Vote on the winning distribution family. Ties broken by input
 * (proposal) order — the first family to reach the top count wins.
 */
function pickWinningDistribution(
  successful: ConsensusProposal[],
): SemanticDistribution {
  const counts = new Map<SemanticDistribution, number>();
  const firstSeen = new Map<SemanticDistribution, number>();
  successful.forEach((proposal, idx) => {
    const d = proposal.bundle!.proposedDistribution;
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (!firstSeen.has(d)) firstSeen.set(d, idx);
  });

  let bestDist: SemanticDistribution = successful[0].bundle!.proposedDistribution;
  let bestCount = -1;
  let bestFirst = Number.POSITIVE_INFINITY;
  for (const [d, c] of counts.entries()) {
    const first = firstSeen.get(d) ?? Number.POSITIVE_INFINITY;
    if (c > bestCount || (c === bestCount && first < bestFirst)) {
      bestDist = d;
      bestCount = c;
      bestFirst = first;
    }
  }
  return bestDist;
}

/**
 * Compute the consensus params within the winning family by widening
 * the envelope. MAX-of-SDs is intentional: a wider posterior is more
 * honest about between-model disagreement (Principle 6).
 *
 * Family-specific rules:
 *   normal / lognormal: MIN(mean) is not meaningful, so we use
 *     MEAN(means) for the centre; MAX(sd) for spread. We ALSO retain
 *     MIN(min)/MAX(max) if any per-model bundle reported them, but for
 *     these two families the contract only requires mean+sd.
 *   beta: MIN(alpha) and MIN(beta) — both lower => the beta is LESS
 *     informative (more uniform-like), which is the conservative
 *     "widen the envelope" choice for a bounded family.
 *   triangular: MIN(min), MAX(max), MEAN(modes) clamped into the
 *     widened [min, max] interval.
 *   uniform: MIN(min), MAX(max).
 */
function widenEnvelope(
  family: SemanticDistribution,
  bundles: ResearchBundle[],
): ProposedParams {
  const out: ProposedParams = {};
  const nums = (key: keyof ProposedParams): number[] =>
    bundles
      .map((b) => b.proposedParams[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  function meanOf(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  switch (family) {
    case "normal":
    case "lognormal": {
      const means = nums("mean");
      const sds = nums("sd");
      if (means.length > 0) out.mean = meanOf(means);
      if (sds.length > 0) out.sd = Math.max(...sds);
      break;
    }
    case "beta": {
      const alphas = nums("alpha");
      const betas = nums("beta");
      if (alphas.length > 0) out.alpha = Math.min(...alphas);
      if (betas.length > 0) out.beta = Math.min(...betas);
      break;
    }
    case "uniform": {
      const mins = nums("min");
      const maxes = nums("max");
      if (mins.length > 0) out.min = Math.min(...mins);
      if (maxes.length > 0) out.max = Math.max(...maxes);
      break;
    }
    case "triangular": {
      const mins = nums("min");
      const maxes = nums("max");
      const modes = nums("mode");
      const widenedMin = mins.length > 0 ? Math.min(...mins) : undefined;
      const widenedMax = maxes.length > 0 ? Math.max(...maxes) : undefined;
      if (widenedMin !== undefined) out.min = widenedMin;
      if (widenedMax !== undefined) out.max = widenedMax;
      if (modes.length > 0) {
        let m = meanOf(modes);
        if (widenedMin !== undefined && m < widenedMin) m = widenedMin;
        if (widenedMax !== undefined && m > widenedMax) m = widenedMax;
        out.mode = m;
      }
      break;
    }
  }

  return out;
}

/**
 * Reduce a bundle to a single "central estimate" used for the
 * disagreement-spread calculation. This is a rough disagreement signal,
 * NOT a calibrated metric — documented as such in the file header.
 */
function centralEstimate(bundle: ResearchBundle): number | undefined {
  const p = bundle.proposedParams;
  switch (bundle.proposedDistribution) {
    case "normal":
    case "lognormal":
      return typeof p.mean === "number" ? p.mean : undefined;
    case "triangular":
      return typeof p.mode === "number" ? p.mode : undefined;
    case "beta": {
      if (typeof p.alpha === "number" && typeof p.beta === "number") {
        const denom = p.alpha + p.beta;
        return denom > 0 ? p.alpha / denom : undefined;
      }
      return undefined;
    }
    case "uniform": {
      if (typeof p.min === "number" && typeof p.max === "number") {
        return (p.min + p.max) / 2;
      }
      return undefined;
    }
  }
}

/**
 * Disagreement score in [0, 1]: (max - min) / max(|max|, |min|, eps),
 * capped at 1. With only one central estimate the spread is 0. Rough,
 * not calibrated — its job is to give the UI a quick sense of "are
 * these models actually disagreeing?".
 */
function computeDisagreementScore(estimates: number[]): number {
  if (estimates.length < 2) return 0;
  const lo = Math.min(...estimates);
  const hi = Math.max(...estimates);
  const spread = hi - lo;
  const scale = Math.max(Math.abs(hi), Math.abs(lo), 1e-9);
  const score = spread / scale;
  if (!Number.isFinite(score) || score < 0) return 0;
  return Math.min(score, 1);
}

function synthesizeConsensus(
  componentId: string,
  successful: ConsensusProposal[],
): { consensus: ResearchBundle; disagreementScore: number } {
  if (successful.length === 1) {
    // Single survivor — copy verbatim but retag mechanism so the UI /
    // state machine consistently sees "multi_llm_consensus" as the
    // primary mechanism, with the per-model citation still surfaced
    // via proposals[].
    const only = successful[0].bundle!;
    return {
      consensus: {
        componentId,
        mechanism: "multi_llm_consensus",
        proposedDistribution: only.proposedDistribution,
        proposedParams: { ...only.proposedParams },
        reasoning: `Consensus from 1 successful proposer:\n${only.reasoning}`,
      },
      disagreementScore: 0,
    };
  }

  const winningFamily = pickWinningDistribution(successful);
  const bundlesInWinningFamily = successful
    .map((p) => p.bundle!)
    .filter((b) => b.proposedDistribution === winningFamily);

  const envelope = widenEnvelope(winningFamily, bundlesInWinningFamily);

  const estimates = bundlesInWinningFamily
    .map(centralEstimate)
    .filter((v): v is number => typeof v === "number");

  const consensusReasoning = [
    `Consensus from ${successful.length} successful proposers — winning family: ${winningFamily}.`,
    `Envelope widened: MIN-of-mins, MAX-of-maxes, MEAN-of-means, MAX-of-SDs.`,
    `Per-model reasoning preserved in proposals[].bundle.reasoning.`,
  ].join(" ");

  return {
    consensus: {
      componentId,
      mechanism: "multi_llm_consensus",
      proposedDistribution: winningFamily,
      proposedParams: envelope,
      reasoning: consensusReasoning,
    },
    disagreementScore: computeDisagreementScore(estimates),
  };
}

// ---------------------------------------------------------------------------
// Concurrency / batch helpers
// ---------------------------------------------------------------------------

function resolveConcurrency(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return DEFAULT_CONCURRENCY;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function researchConsensus(
  opts: ConsensusResearchOptions,
): Promise<ConsensusResearchResult> {
  if (!Array.isArray(opts.models) || opts.models.length < 2) {
    throw new ConsensusResearchError(
      `researchConsensus requires at least 2 models; got ${
        Array.isArray(opts.models) ? opts.models.length : 0
      }`,
      "EMPTY_MODELS",
    );
  }
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    // Surface as EMPTY_MODELS-adjacent failure via a synthetic error
    // throw — but apiKey is a hard precondition, so use a plain Error
    // (callers should never pass an empty key; the no-mock rule means
    // we expect a real key in every consumer).
    throw new Error("researchConsensus requires a non-empty apiKey");
  }
  if (
    typeof opts.component !== "object" ||
    opts.component === null ||
    typeof opts.component.id !== "string" ||
    opts.component.id.trim() === ""
  ) {
    throw new Error("researchConsensus requires a component with a non-empty id");
  }

  const concurrency = resolveConcurrency(opts.concurrencyLimit);
  const models = opts.models.slice();
  const proposals: ConsensusProposal[] = new Array(models.length);

  let nextIndex = 0;
  const wallStart = Date.now();

  async function worker(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = nextIndex++;
      if (i >= models.length) return;
      proposals[i] = await runOneProposer(models[i], opts);
    }
  }

  const workerCount = Math.min(concurrency, models.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  const wallTimeMs = Date.now() - wallStart;

  const successful = proposals.filter(
    (p): p is ConsensusProposal & { bundle: ResearchBundle } => p.bundle !== undefined,
  );
  const successCount = successful.length;
  const errorCount = proposals.length - successCount;
  const totalCostUsd = proposals.reduce((acc, p) => acc + (p.costUsd || 0), 0);

  if (successCount === 0) {
    throw new ConsensusResearchError(
      `researchConsensus: all ${proposals.length} proposer(s) failed (${proposals
        .map((p) => `${p.model}=${p.error ?? "unknown"}`)
        .join("; ")})`,
      "ALL_PROPOSERS_FAILED",
    );
  }

  const { consensus, disagreementScore } = synthesizeConsensus(
    opts.component.id,
    successful,
  );

  return {
    proposals,
    consensus,
    disagreementScore,
    successCount,
    errorCount,
    totalCostUsd,
    wallTimeMs,
  };
}
