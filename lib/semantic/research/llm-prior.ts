/**
 * Semantic Mode — Phase B1: LLM-prior research mechanism.
 *
 * For ONE proposed component, this adapter asks the configured LLM to:
 *   1. Confirm or revise the component's suggested distribution.
 *   2. Propose the parameters that fit that distribution
 *      (mean/sd for normal/lognormal, alpha/beta for beta, min/max for
 *      uniform, min/mode/max for triangular).
 *   3. Explain in 2-3 sentences WHY this distribution and WHY these numbers.
 *   4. Cite any general-knowledge sources by NAME (textbooks, datasets,
 *      well-known references). No URLs here — Phase B2 web-search is the
 *      mechanism for URL-bearing citations.
 *
 * The output is a `ResearchBundle` with `mechanism: "llm_prior"` that the
 * Semantic Mode state machine accepts via the `researchReceived` event
 * (see `lib/semantic/state-machine.ts`).
 *
 * Design decisions:
 *
 *  1. Every LLM call routes through `lib/ai/openrouter-client.callChat` so
 *     the project-wide timeout, single-retry, and per-call cost ceiling
 *     are enforced uniformly. No raw fetch.
 *
 *  2. The model id is always caller-supplied. We never read a default
 *     model from env (workspace CLAUDE.md: the user selects all model
 *     versions).
 *
 *  3. Distribution mismatch handling: if the LLM picks a distribution
 *     different from the component's suggestedDistribution, we accept it
 *     ONLY when the reasoning explicitly references the original family.
 *     Silent revision is rejected with `DISTRIBUTION_MISMATCH` so the
 *     user never gets a different model than they were primed to expect
 *     without an audit-visible explanation.
 *
 *  4. Param-shape validation is strict per family:
 *       normal / lognormal -> {mean: finite, sd: finite > 0}
 *       beta               -> {alpha > 0, beta > 0}
 *       uniform            -> {min: finite, max: finite, min < max}
 *       triangular         -> {min, mode, max, min <= mode <= max}
 *     Any deviation is rejected with `INVALID_PARAMS`. The reasoning
 *     string must be non-empty; `citationNames` must be an array (empty
 *     is allowed — explicit "no general source" is legitimate).
 *
 *  5. `OpenRouterCallError` is wrapped in
 *     `LlmPriorResearchError("OPENROUTER_ERROR")` so callers only need to
 *     import one error type from this module.
 *
 *  6. The system prompt embeds two worked examples (one beta, one
 *     triangular) per the v2 addendum's mandatory few-shot rule. Without
 *     them, the LLM regressed to flat / generic param-only output in
 *     analogous A3/A4 steps; same risk applies here.
 */

import {
  callChat,
  OpenRouterCallError,
  type CallChatOptions,
} from "@/lib/ai/openrouter-client";
import type {
  ClarifyingQuestion,
  ProposedComponent,
  ProposedParams,
  ResearchBundle,
  SemanticDistribution,
} from "@/lib/semantic/types";
import llmPriorExamples from "@/lib/ai/examples/llm-prior-research-examples.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A citation surfaced by the LLM-prior research mechanism. URLs are
 * intentionally omitted at this layer; Phase B2 (web-search) is where
 * URL-bearing citations belong.
 */
export interface LlmPriorCitation {
  source: string;
}

/**
 * The bundle returned by `researchLlmPrior`. Structurally compatible
 * with `ResearchBundle` (state machine accepts it via the
 * `researchReceived` event); adds the `citations` payload that the
 * downstream UI renders alongside the reasoning.
 */
export interface LlmPriorResearchBundle extends ResearchBundle {
  mechanism: "llm_prior";
  citations: LlmPriorCitation[];
}

export interface LlmPriorResearchOptions {
  component: ProposedComponent;
  /** Original natural-language question for context. */
  query: string;
  clarifications?: Array<{
    question: { id: string; question: string };
    answer: string;
  }>;
  /** OpenRouter model id. Caller-supplied; never hardcoded. */
  model: string;
  apiKey: string;
  timeoutMs?: number;
  costBudgetUsd?: number;
  /** Test-harness fetch injection only; production passes nothing. */
  fetchImpl?: CallChatOptions["fetchImpl"];
}

export interface LlmPriorResearchResult {
  bundle: LlmPriorResearchBundle;
  model: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export type LlmPriorResearchErrorCode =
  | "INVALID_RESPONSE"
  | "DISTRIBUTION_MISMATCH"
  | "MISSING_PARAMS"
  | "INVALID_PARAMS"
  | "OPENROUTER_ERROR";

export class LlmPriorResearchError extends Error {
  readonly code: LlmPriorResearchErrorCode;

  constructor(message: string, code: LlmPriorResearchErrorCode) {
    super(message);
    this.name = "LlmPriorResearchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_DISTRIBUTIONS: ReadonlyArray<SemanticDistribution> = [
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
];

const DEFAULT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface LlmPriorExampleFile {
  examples: ReadonlyArray<{
    component: ProposedComponent;
    response: {
      distribution: SemanticDistribution;
      params: Record<string, number>;
      reasoning: string;
      citationNames: string[];
    };
  }>;
}

// The `as unknown as` two-step is required because the inferred JSON
// type narrows `distribution` and `suggestedDistribution` to string
// literals that TypeScript cannot directly widen to the SemanticDistribution
// union. Same pattern as lib/semantic/clarify.ts.
const EXAMPLES = (llmPriorExamples as unknown as LlmPriorExampleFile).examples;

const SYSTEM_PROMPT_BASE = `You are an expert uncertainty-modeling assistant for finESS.

A user is building an uncertainty model from a natural-language question.
The components were already proposed and the user accepted them. You are
now researching ONE component from your own general knowledge (no web,
no documents). Your output is a probability distribution over the value
that component can take, plus a short explanation.

DO:
- Confirm or revise the suggestedDistribution. If you revise, your
  reasoning MUST explicitly explain why the original family was wrong
  (mention the original family by name). Silent revisions are rejected.
- Propose distribution parameters in the exact shape required for the
  family:
    normal     -> { "mean": number, "sd": number > 0 }
    lognormal  -> { "mean": number, "sd": number > 0 }
    beta       -> { "alpha": number > 0, "beta": number > 0 }
    uniform    -> { "min": number, "max": number > min }
    triangular -> { "min": number, "mode": number, "max": number, with min <= mode <= max }
- Write 2-3 sentences explaining WHY this distribution family and WHY
  these specific numbers. Reference the relevant base rate, scale, or
  shape constraint.
- Cite any general-knowledge sources by NAME (textbook chapters,
  well-known datasets, published benchmark reports). Do not invent URLs;
  source NAMES only. If you have no general-knowledge source to cite,
  return an empty array.

DO NOT:
- Use statistical jargon the user would not recognize (no "conjugate
  prior", no "MLE", no "log-likelihood"). Plain numbers, plain language.
- Invent URLs or DOIs. You do not have web access in this step.
- Output any extra fields. Only "distribution", "params", "reasoning",
  "citationNames".

Output strict JSON:
{
  "distribution": "beta" | "normal" | "uniform" | "lognormal" | "triangular",
  "params": { ... shape depends on distribution ... },
  "reasoning": "2-3 sentences explaining the choice and the numbers.",
  "citationNames": ["Name of source 1", "Name of source 2"]
}

Return ONLY the JSON object — no markdown fences, no prose before or after.
`;

/**
 * Build the system prompt by appending the worked example(s). Per v2
 * addendum the worked example is MANDATORY for this kind of structured
 * LLM step.
 */
export function buildLlmPriorSystemPrompt(): string {
  if (EXAMPLES.length === 0) return SYSTEM_PROMPT_BASE;

  const exampleBlocks = EXAMPLES.map((ex) => {
    return `WORKED EXAMPLE
Component:
${JSON.stringify(ex.component, null, 2)}

Expected response:
${JSON.stringify(ex.response, null, 2)}`;
  }).join("\n\n");

  return `${SYSTEM_PROMPT_BASE}\n${exampleBlocks}\n`;
}

/**
 * Build the user message that combines the original query, the
 * clarifying Q&A (if any), and the focused component description.
 */
export function buildLlmPriorUserMessage(
  query: string,
  component: ProposedComponent,
  clarifications: LlmPriorResearchOptions["clarifications"] = [],
): string {
  const qaSection = clarifications.length
    ? `Clarifying Q&A:\n${clarifications
        .map((pair) => `Q: ${pair.question.question}\nA: ${pair.answer}`)
        .join("\n\n")}\n\n`
    : "";
  const suggestedLine = component.suggestedDistribution
    ? `Suggested distribution family (from the component-proposal step): ${component.suggestedDistribution}\n`
    : "";
  return `Original question:\n${query}\n\n${qaSection}Research this single component:
- id: ${component.id}
- name: ${component.name}
- description: ${component.description}
${suggestedLine}
Return the JSON response now.`;
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

interface ParsedLlmResponse {
  distribution: SemanticDistribution;
  params: Record<string, number>;
  reasoning: string;
  citationNames: string[];
}

function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }
  return cleaned;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate the params object against the required shape for the
 * distribution family. Throws `LlmPriorResearchError("MISSING_PARAMS")`
 * when a required key is absent and `INVALID_PARAMS` when a key is
 * present but malformed (wrong type, non-finite, or violates an ordering
 * / positivity constraint).
 */
function validateParamsForDistribution(
  distribution: SemanticDistribution,
  params: Record<string, unknown>,
): ProposedParams {
  switch (distribution) {
    case "normal":
    case "lognormal": {
      if (!("mean" in params) || !("sd" in params)) {
        throw new LlmPriorResearchError(
          `${distribution} requires { mean, sd }; missing keys`,
          "MISSING_PARAMS",
        );
      }
      const mean = params.mean;
      const sd = params.sd;
      if (!isFiniteNumber(mean)) {
        throw new LlmPriorResearchError(
          `${distribution} params.mean must be a finite number`,
          "INVALID_PARAMS",
        );
      }
      if (!isFiniteNumber(sd) || sd <= 0) {
        throw new LlmPriorResearchError(
          `${distribution} params.sd must be a finite number > 0 (got ${String(sd)})`,
          "INVALID_PARAMS",
        );
      }
      return { mean, sd };
    }
    case "beta": {
      if (!("alpha" in params) || !("beta" in params)) {
        throw new LlmPriorResearchError(
          "beta requires { alpha, beta }; missing keys",
          "MISSING_PARAMS",
        );
      }
      const alpha = params.alpha;
      const betaVal = params.beta;
      if (!isFiniteNumber(alpha) || alpha <= 0) {
        throw new LlmPriorResearchError(
          `beta params.alpha must be a finite number > 0 (got ${String(alpha)})`,
          "INVALID_PARAMS",
        );
      }
      if (!isFiniteNumber(betaVal) || betaVal <= 0) {
        throw new LlmPriorResearchError(
          `beta params.beta must be a finite number > 0 (got ${String(betaVal)})`,
          "INVALID_PARAMS",
        );
      }
      return { alpha, beta: betaVal };
    }
    case "uniform": {
      if (!("min" in params) || !("max" in params)) {
        throw new LlmPriorResearchError(
          "uniform requires { min, max }; missing keys",
          "MISSING_PARAMS",
        );
      }
      const min = params.min;
      const max = params.max;
      if (!isFiniteNumber(min) || !isFiniteNumber(max)) {
        throw new LlmPriorResearchError(
          "uniform params.min and params.max must both be finite numbers",
          "INVALID_PARAMS",
        );
      }
      if (!(min < max)) {
        throw new LlmPriorResearchError(
          `uniform params requires min < max (got min=${min}, max=${max})`,
          "INVALID_PARAMS",
        );
      }
      return { min, max };
    }
    case "triangular": {
      if (
        !("min" in params) ||
        !("mode" in params) ||
        !("max" in params)
      ) {
        throw new LlmPriorResearchError(
          "triangular requires { min, mode, max }; missing keys",
          "MISSING_PARAMS",
        );
      }
      const min = params.min;
      const mode = params.mode;
      const max = params.max;
      if (
        !isFiniteNumber(min) ||
        !isFiniteNumber(mode) ||
        !isFiniteNumber(max)
      ) {
        throw new LlmPriorResearchError(
          "triangular params.min, params.mode, params.max must all be finite numbers",
          "INVALID_PARAMS",
        );
      }
      if (!(min <= mode && mode <= max)) {
        throw new LlmPriorResearchError(
          `triangular params requires min <= mode <= max (got min=${min}, mode=${mode}, max=${max})`,
          "INVALID_PARAMS",
        );
      }
      if (min === max) {
        throw new LlmPriorResearchError(
          "triangular params requires a non-degenerate range (min === max collapses the distribution)",
          "INVALID_PARAMS",
        );
      }
      return { min, mode, max };
    }
  }
}

/**
 * Heuristic: does the reasoning explicitly mention the original
 * suggested-distribution family? Used when the LLM picks a different
 * distribution than the one the component was primed with — silent
 * revision is rejected; revision with a named justification is accepted.
 *
 * Match is case-insensitive on the bare family name as a whole word so
 * "normal" inside "abnormal" does not false-positive.
 */
function reasoningJustifiesRevision(
  reasoning: string,
  originalFamily: SemanticDistribution,
): boolean {
  const re = new RegExp(`\\b${originalFamily}\\b`, "i");
  return re.test(reasoning);
}

function parseAndValidate(
  rawContent: string,
  suggestedDistribution: SemanticDistribution | undefined,
): ParsedLlmResponse {
  const cleaned = stripMarkdownFences(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmPriorResearchError(
      `LLM response was not valid JSON: ${message}`,
      "INVALID_RESPONSE",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LlmPriorResearchError(
      "LLM response must be a JSON object",
      "INVALID_RESPONSE",
    );
  }

  const root = parsed as Record<string, unknown>;

  // ---- distribution ----
  if (typeof root.distribution !== "string") {
    throw new LlmPriorResearchError(
      "LLM response is missing 'distribution' string",
      "INVALID_RESPONSE",
    );
  }
  if (
    !(VALID_DISTRIBUTIONS as ReadonlyArray<string>).includes(root.distribution)
  ) {
    throw new LlmPriorResearchError(
      `LLM returned unsupported distribution '${root.distribution}'. Must be one of: ${VALID_DISTRIBUTIONS.join(", ")}`,
      "INVALID_RESPONSE",
    );
  }
  const distribution = root.distribution as SemanticDistribution;

  // ---- reasoning ----
  if (typeof root.reasoning !== "string" || root.reasoning.trim() === "") {
    throw new LlmPriorResearchError(
      "LLM response is missing a non-empty 'reasoning' string",
      "INVALID_RESPONSE",
    );
  }
  const reasoning = root.reasoning.trim();

  // ---- citationNames ----
  if (!Array.isArray(root.citationNames)) {
    throw new LlmPriorResearchError(
      "LLM response 'citationNames' must be an array (empty array is acceptable)",
      "INVALID_RESPONSE",
    );
  }
  const citationNames: string[] = [];
  for (let i = 0; i < root.citationNames.length; i++) {
    const item = root.citationNames[i];
    if (typeof item !== "string" || item.trim() === "") {
      throw new LlmPriorResearchError(
        `LLM response 'citationNames[${i}]' must be a non-empty string`,
        "INVALID_RESPONSE",
      );
    }
    citationNames.push(item.trim());
  }

  // ---- params (shape check first, then per-family validation) ----
  if (
    typeof root.params !== "object" ||
    root.params === null ||
    Array.isArray(root.params)
  ) {
    throw new LlmPriorResearchError(
      "LLM response is missing 'params' object",
      "MISSING_PARAMS",
    );
  }
  const paramsRecord = root.params as Record<string, unknown>;

  // ---- distribution-mismatch gate ----
  // If the LLM picked a different family than the component suggested,
  // its reasoning must explicitly reference the original family.
  if (
    suggestedDistribution !== undefined &&
    distribution !== suggestedDistribution &&
    !reasoningJustifiesRevision(reasoning, suggestedDistribution)
  ) {
    throw new LlmPriorResearchError(
      `LLM revised distribution from '${suggestedDistribution}' to '${distribution}' without referencing the original family in its reasoning`,
      "DISTRIBUTION_MISMATCH",
    );
  }

  // Per-family shape + bounds validation. May throw MISSING_PARAMS or
  // INVALID_PARAMS; both are surfaced unchanged to the caller.
  const validatedParams = validateParamsForDistribution(
    distribution,
    paramsRecord,
  );

  return {
    distribution,
    params: validatedParams as Record<string, number>,
    reasoning,
    citationNames,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one LLM-prior research pass on the given component and return the
 * resulting `ResearchBundle` (mechanism: "llm_prior").
 */
export async function researchLlmPrior(
  opts: LlmPriorResearchOptions,
): Promise<LlmPriorResearchResult> {
  // Pre-flight: caller-side argument validation. Same shape as A3/A4 —
  // typed throws so the caller never burns a token on a malformed call.
  if (
    typeof opts.component !== "object" ||
    opts.component === null ||
    typeof opts.component.id !== "string" ||
    opts.component.id.trim() === ""
  ) {
    throw new LlmPriorResearchError(
      "researchLlmPrior requires a component with a non-empty id",
      "INVALID_RESPONSE",
    );
  }
  if (
    typeof opts.component.name !== "string" ||
    opts.component.name.trim() === ""
  ) {
    throw new LlmPriorResearchError(
      `researchLlmPrior requires component.name to be non-empty (component id '${opts.component.id}')`,
      "INVALID_RESPONSE",
    );
  }
  if (
    typeof opts.component.description !== "string" ||
    opts.component.description.trim() === ""
  ) {
    throw new LlmPriorResearchError(
      `researchLlmPrior requires component.description to be non-empty (component id '${opts.component.id}')`,
      "INVALID_RESPONSE",
    );
  }
  if (typeof opts.query !== "string" || opts.query.trim() === "") {
    throw new LlmPriorResearchError(
      "researchLlmPrior requires a non-empty query for context",
      "INVALID_RESPONSE",
    );
  }
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new LlmPriorResearchError(
      "researchLlmPrior requires a non-empty model id (user-supplied; never hardcoded)",
      "OPENROUTER_ERROR",
    );
  }
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    throw new LlmPriorResearchError(
      "researchLlmPrior requires a non-empty apiKey",
      "OPENROUTER_ERROR",
    );
  }

  const systemPrompt = buildLlmPriorSystemPrompt();
  const userMessage = buildLlmPriorUserMessage(
    opts.query,
    opts.component,
    opts.clarifications,
  );

  let callResult;
  try {
    callResult = await callChat({
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      responseFormat: { type: "json_object" },
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic LLM-Prior Research",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      throw new LlmPriorResearchError(
        `OpenRouter call failed: ${err.code}${
          err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""
        } (${err.message})`,
        "OPENROUTER_ERROR",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmPriorResearchError(
      `OpenRouter call failed: ${message}`,
      "OPENROUTER_ERROR",
    );
  }

  const parsed = parseAndValidate(
    callResult.content,
    opts.component.suggestedDistribution,
  );

  const bundle: LlmPriorResearchBundle = {
    componentId: opts.component.id,
    mechanism: "llm_prior",
    proposedDistribution: parsed.distribution,
    proposedParams: parsed.params as ProposedParams,
    reasoning: parsed.reasoning,
    citations: parsed.citationNames.map((source) => ({ source })),
  };

  return {
    bundle,
    model: callResult.model,
    latencyMs: callResult.latencyMs,
    costUsd: callResult.costUsd,
    retryCount: callResult.retryCount,
  };
}

/** Re-export the clarifying-question shape used in the options. */
export type { ClarifyingQuestion };
