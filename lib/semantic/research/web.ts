/**
 * Semantic Mode — Phase B2 web-search research mechanism.
 *
 * Given a single ProposedComponent, this module:
 *   1. Issues a web search through the configured SearchProvider
 *      (currently Tavily via lib/search/index.ts).
 *   2. Hands the returned snippets PLUS component context to the LLM,
 *      asking it to extract a probability distribution + parameters +
 *      plain-language reasoning + per-claim citations.
 *   3. Validates the LLM response strictly (distribution-specific
 *      parameter rules mirroring lib/validation/schemas.ts) and emits
 *      a ResearchBundle with mechanism = "web_search".
 *
 * Design notes mirroring other Phase A/B modules:
 *   - All LLM calls go through lib/ai/openrouter-client.callChat so
 *     timeout / single-retry / cost ceiling are enforced uniformly.
 *   - The model id is always caller-supplied; never hard-coded
 *     (workspace CLAUDE.md rule).
 *   - Errors are typed via WebResearchError so the route handler /
 *     UI can map specific failures to actionable copy.
 *   - The returned bundle's `componentId` is forced to
 *     `opts.component.id`. If the LLM hallucinates a different id we
 *     overwrite — the validator downstream (lib/validation/semantic.ts)
 *     would otherwise reject the mismatch and we lose the work.
 *   - Citations are first-class on the returned bundle. The
 *     ResearchBundle TS type does not declare citations today, but
 *     downstream consumers (UI, exporter) read them via the wider
 *     WebResearchBundle interface defined here.
 *
 * Error code semantics:
 *   - INVALID_PARAMS    : LLM returned a bundle but the params do not
 *                         match the distribution's required shape
 *                         (e.g. beta missing alpha, normal sd <= 0).
 *   - INVALID_RESPONSE  : LLM returned malformed JSON, wrong top-level
 *                         shape, or invalid citations.
 *   - NO_RESULTS        : Tavily returned zero snippets; we refuse to
 *                         fabricate citations from nothing.
 *   - SEARCH_ERROR      : Any SearchError from the provider (auth,
 *                         timeout, network, 5xx).
 *   - INVALID_PARAMS    : (see above)
 *   - OPENROUTER_ERROR  : Any OpenRouterCallError from the extractor
 *                         LLM call.
 */

import {
  callChat,
  OpenRouterCallError,
} from "@/lib/ai/openrouter-client";
import { getSearchProvider, SearchError } from "@/lib/search";
import type { SearchSnippet } from "@/lib/search";
import type {
  ProposedComponent,
  ResearchBundle,
  SemanticDistribution,
} from "@/lib/semantic/types";
import webResearchExamples from "@/lib/ai/examples/web-research-extraction-examples.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single citation on a web-research bundle. URL is the snippet's
 * source page. The snippet text is the verbatim slice the LLM is
 * claiming supports the proposed distribution / params.
 */
export interface Citation {
  url: string;
  title?: string;
  snippet: string;
}

/**
 * ResearchBundle widened with first-class `citations`. We do not
 * modify the shared ResearchBundle in lib/semantic/types.ts (other
 * Phase B agents own that file); instead the web-search orchestrator
 * returns this wider shape, and citations are read by consumers
 * that opt into this type.
 */
export interface WebResearchBundle extends ResearchBundle {
  citations: Citation[];
}

export interface WebResearchOptions {
  component: ProposedComponent;
  /**
   * Search query for the provider. Caller-supplied so the consumer
   * can tune phrasing per domain; we do not auto-generate from
   * component.name alone (`researchWeb` does build a reasonable
   * default if the caller passes an empty string).
   */
  query: string;
  /** Clarifying Q&A pairs from Phase A3 (improves extractor quality). */
  clarifications?: Array<{
    question: { id: string; question: string };
    answer: string;
  }>;
  /** OpenRouter model id for the extractor LLM call. */
  model: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Tavily (or other provider) API key. */
  tavilyApiKey: string;
  /** Cap on Tavily snippets requested. Default 5. */
  searchMaxResults?: number;
  /** Per-LLM-call timeout override (ms). */
  timeoutMs?: number;
  /** Per-LLM-call cost ceiling override (USD). */
  costBudgetUsd?: number;
  /** Test-harness fetch injection only; production passes nothing. */
  fetchImpl?: typeof fetch;
}

export interface WebResearchResult {
  bundle: WebResearchBundle;
  /** Model id reported by OpenRouter (may differ from requested id). */
  model: string;
  /** LLM call latency in ms (does not include search). */
  latencyMs: number;
  /** LLM call cost in USD (does not include search; Tavily is metered separately). */
  costUsd: number;
  retryCount: number;
  /** Number of snippets that survived provider filtering. */
  snippetCount: number;
  /** Stable provider id for audit / UI. */
  searchProvider: string;
}

export type WebResearchErrorCode =
  | "NO_RESULTS"
  | "SEARCH_ERROR"
  | "INVALID_RESPONSE"
  | "INVALID_PARAMS"
  | "OPENROUTER_ERROR";

export class WebResearchError extends Error {
  readonly code: WebResearchErrorCode;
  /** Optional pass-through of the underlying SearchError code. */
  readonly searchErrorCode?: string;

  constructor(
    message: string,
    code: WebResearchErrorCode,
    searchErrorCode?: string,
  ) {
    super(message);
    this.name = "WebResearchError";
    this.code = code;
    this.searchErrorCode = searchErrorCode;
  }
}

// ---------------------------------------------------------------------------
// Allowlists / constants
// ---------------------------------------------------------------------------

const VALID_DISTRIBUTIONS: ReadonlyArray<SemanticDistribution> = [
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
];

const DEFAULT_SEARCH_MAX_RESULTS = 5;
const DEFAULT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface WebResearchExampleFile {
  examples: Array<{
    domain: string;
    component: {
      id: string;
      name: string;
      description: string;
      suggestedDistribution?: string;
    };
    snippets: Array<{ title: string; url: string; content: string }>;
    response: {
      distribution: string;
      params: Record<string, number>;
      reasoning: string;
      citations: Citation[];
    };
  }>;
}

const EXAMPLES = (webResearchExamples as WebResearchExampleFile).examples;

const SYSTEM_PROMPT_BASE = `You are an expert uncertainty-modeling assistant for finESS.

You are given:
  - One COMPONENT (an uncertain quantity that affects a downstream decision).
  - N WEB SNIPPETS retrieved from a live search for this component.
  - Optional CLARIFYING ANSWERS from earlier in the conversation.

Your job: extract a probability distribution + parameters + plain-language
reasoning + per-claim citations.

Allowed distribution families and required params:
  - "beta"        : { alpha, beta }              (both > 0)
  - "normal"      : { mean, sd }                 (sd > 0)
  - "uniform"     : { min, max }                 (min < max)
  - "lognormal"   : { mean, sd }                 (sd > 0; mean > 0 strongly preferred)
  - "triangular"  : { min, mode, max }           (min <= mode <= max, min < max)

RULES
  - Pick the distribution that best fits the kind of quantity this is:
      beta       -> bounded probabilities / fractions in [0, 1]
      normal     -> continuous symmetric uncertainty
      uniform    -> known min/max with no central tendency
      lognormal  -> positive right-skewed quantities (costs, sizes, durations)
      triangular -> bounded with a known most-likely value
  - Honor the component's suggestedDistribution if it is consistent with the
    snippets. Override only with a one-sentence explanation in reasoning.
  - Anchor parameters on numbers that appear in the snippets. If snippets
    disagree, use the central tendency and widen the spread to cover both.
  - reasoning: 2-3 sentences in plain language; non-statistical user.
  - citations: array of {url, title, snippet} for each piece of supporting
    evidence. The url MUST come verbatim from one of the snippets supplied
    to you — do NOT invent URLs. The snippet field is the short slice of
    the snippet content you are leaning on for the claim.
  - Citations must have at least one entry. A bundle with zero citations
    is invalid.

Output strict JSON in this exact shape (no markdown fences, no prose):

{
  "distribution": "beta" | "normal" | "uniform" | "lognormal" | "triangular",
  "params": { ... per-distribution params above ... },
  "reasoning": "...",
  "citations": [ { "url": "...", "title": "...", "snippet": "..." }, ... ]
}
`;

export function buildExtractorSystemPrompt(): string {
  if (EXAMPLES.length === 0) return SYSTEM_PROMPT_BASE;
  const blocks = EXAMPLES.map((ex) => {
    const snippetLines = ex.snippets
      .map((s, i) => `Snippet ${i + 1}: ${s.title}\nURL: ${s.url}\n${s.content}`)
      .join("\n\n");
    return `WORKED EXAMPLE

Component:
${JSON.stringify(ex.component, null, 2)}

Snippets:
${snippetLines}

Expected response:
${JSON.stringify(ex.response, null, 2)}`;
  }).join("\n\n");
  return `${SYSTEM_PROMPT_BASE}\n${blocks}\n`;
}

export function buildExtractorUserMessage(
  component: ProposedComponent,
  snippets: SearchSnippet[],
  clarifications: WebResearchOptions["clarifications"],
): string {
  const lines: string[] = [];
  lines.push(`Component:`);
  lines.push(
    JSON.stringify(
      {
        id: component.id,
        name: component.name,
        description: component.description,
        suggestedDistribution: component.suggestedDistribution,
        why: component.why,
      },
      null,
      2,
    ),
  );
  if (clarifications && clarifications.length > 0) {
    lines.push("");
    lines.push("Clarifying Q&A:");
    for (const pair of clarifications) {
      lines.push(`Q: ${pair.question.question}`);
      lines.push(`A: ${pair.answer}`);
    }
  }
  lines.push("");
  lines.push(`Search snippets (${snippets.length}):`);
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    lines.push("");
    lines.push(`Snippet ${i + 1}: ${s.title || "(untitled)"}`);
    lines.push(`URL: ${s.url}`);
    lines.push(s.content);
  }
  lines.push("");
  lines.push(
    "Extract the distribution, params, reasoning, and citations now. Return ONLY the JSON object.",
  );
  return lines.join("\n");
}

function defaultQueryFor(component: ProposedComponent): string {
  // The plan: "Build a search query by concatenating component.name +
  // ` distribution range estimate`." Keep it simple; tune later.
  return `${component.name} distribution range estimate`;
}

// ---------------------------------------------------------------------------
// Parsing / validation
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requirePositiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WebResearchError(
      `params.${field} must be a positive finite number`,
      "INVALID_PARAMS",
    );
  }
  return value;
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WebResearchError(
      `params.${field} must be a finite number`,
      "INVALID_PARAMS",
    );
  }
  return value;
}

/**
 * Per-distribution parameter validation. Mirrors the engine's
 * sampleDistribution preconditions so a bundle that passes here will
 * not blow up downstream in the Monte Carlo sampler.
 */
function validateParamsForDistribution(
  distribution: SemanticDistribution,
  params: Record<string, unknown>,
): Record<string, number> {
  switch (distribution) {
    case "beta": {
      const alpha = requirePositiveFinite(params.alpha, "alpha");
      const beta = requirePositiveFinite(params.beta, "beta");
      return { alpha, beta };
    }
    case "normal": {
      const mean = requireFinite(params.mean, "mean");
      const sd = requirePositiveFinite(params.sd, "sd");
      return { mean, sd };
    }
    case "uniform": {
      const min = requireFinite(params.min, "min");
      const max = requireFinite(params.max, "max");
      if (!(min < max)) {
        throw new WebResearchError(
          `params.min (${min}) must be strictly less than params.max (${max}) for uniform`,
          "INVALID_PARAMS",
        );
      }
      return { min, max };
    }
    case "lognormal": {
      const mean = requireFinite(params.mean, "mean");
      const sd = requirePositiveFinite(params.sd, "sd");
      return { mean, sd };
    }
    case "triangular": {
      const min = requireFinite(params.min, "min");
      const mode = requireFinite(params.mode, "mode");
      const max = requireFinite(params.max, "max");
      if (!(min < max)) {
        throw new WebResearchError(
          `triangular requires min < max (got min=${min}, max=${max})`,
          "INVALID_PARAMS",
        );
      }
      if (!(min <= mode && mode <= max)) {
        throw new WebResearchError(
          `triangular requires min <= mode <= max (got min=${min}, mode=${mode}, max=${max})`,
          "INVALID_PARAMS",
        );
      }
      return { min, mode, max };
    }
    default: {
      // Exhaustive check; the outer caller has already validated the
      // distribution string against the allowlist.
      throw new WebResearchError(
        `Unsupported distribution: ${String(distribution)}`,
        "INVALID_PARAMS",
      );
    }
  }
}

function validateCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) {
    throw new WebResearchError(
      "extractor response: 'citations' must be an array",
      "INVALID_RESPONSE",
    );
  }
  if (value.length === 0) {
    throw new WebResearchError(
      "extractor response: 'citations' must not be empty (web-search bundles require at least one supporting citation)",
      "INVALID_RESPONSE",
    );
  }
  const out: Citation[] = [];
  for (let i = 0; i < value.length; i++) {
    const rec = asRecord(value[i]);
    if (!rec) {
      throw new WebResearchError(
        `extractor response: citations[${i}] is not an object`,
        "INVALID_RESPONSE",
      );
    }
    if (typeof rec.url !== "string" || rec.url.trim() === "") {
      throw new WebResearchError(
        `extractor response: citations[${i}].url must be a non-empty string`,
        "INVALID_RESPONSE",
      );
    }
    if (typeof rec.snippet !== "string" || rec.snippet.trim() === "") {
      throw new WebResearchError(
        `extractor response: citations[${i}].snippet must be a non-empty string`,
        "INVALID_RESPONSE",
      );
    }
    const cit: Citation = {
      url: rec.url.trim(),
      snippet: rec.snippet.trim(),
    };
    if (typeof rec.title === "string" && rec.title.trim() !== "") {
      cit.title = rec.title.trim();
    }
    out.push(cit);
  }
  return out;
}

export interface ParsedExtractorPayload {
  distribution: SemanticDistribution;
  params: Record<string, number>;
  reasoning: string;
  citations: Citation[];
}

export function parseExtractorResponse(content: string): ParsedExtractorPayload {
  const cleaned = stripMarkdownFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WebResearchError(
      `extractor response is not valid JSON: ${message}`,
      "INVALID_RESPONSE",
    );
  }

  const rec = asRecord(parsed);
  if (!rec) {
    throw new WebResearchError(
      "extractor response must be a JSON object",
      "INVALID_RESPONSE",
    );
  }

  const distRaw = rec.distribution;
  if (
    typeof distRaw !== "string" ||
    !(VALID_DISTRIBUTIONS as ReadonlyArray<string>).includes(distRaw)
  ) {
    throw new WebResearchError(
      `extractor response: distribution "${String(distRaw)}" is not one of ${VALID_DISTRIBUTIONS.join(", ")}`,
      "INVALID_RESPONSE",
    );
  }
  const distribution = distRaw as SemanticDistribution;

  const paramsRec = asRecord(rec.params);
  if (!paramsRec) {
    throw new WebResearchError(
      "extractor response: 'params' must be an object",
      "INVALID_RESPONSE",
    );
  }
  const params = validateParamsForDistribution(distribution, paramsRec);

  if (typeof rec.reasoning !== "string" || rec.reasoning.trim() === "") {
    throw new WebResearchError(
      "extractor response: 'reasoning' must be a non-empty string",
      "INVALID_RESPONSE",
    );
  }
  const reasoning = rec.reasoning.trim();

  const citations = validateCitations(rec.citations);

  return { distribution, params, reasoning, citations };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function researchWeb(
  opts: WebResearchOptions,
): Promise<WebResearchResult> {
  // ---- input guards (fail before spending any external call) -------------
  if (!opts.component || typeof opts.component.id !== "string" || opts.component.id.trim() === "") {
    throw new WebResearchError(
      "researchWeb requires a component with a non-empty id",
      "INVALID_RESPONSE",
    );
  }
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new WebResearchError(
      "researchWeb requires a non-empty model id (user-supplied; never hardcoded)",
      "OPENROUTER_ERROR",
    );
  }
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    throw new WebResearchError(
      "researchWeb requires a non-empty OpenRouter apiKey",
      "OPENROUTER_ERROR",
    );
  }
  if (typeof opts.tavilyApiKey !== "string" || opts.tavilyApiKey.trim() === "") {
    throw new WebResearchError(
      "researchWeb requires a non-empty tavilyApiKey",
      "SEARCH_ERROR",
      "AUTH",
    );
  }

  const queryText =
    typeof opts.query === "string" && opts.query.trim() !== ""
      ? opts.query.trim()
      : defaultQueryFor(opts.component);

  const provider = getSearchProvider("tavily");

  // ---- step 1: search ----------------------------------------------------
  let searchResult;
  try {
    searchResult = await provider.search(
      {
        query: queryText,
        maxResults: opts.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
        // Use a tighter default for the search leg so the total
        // researchWeb call stays under the LLM timeout.
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
      },
      opts.tavilyApiKey,
    );
  } catch (err) {
    if (err instanceof SearchError) {
      throw new WebResearchError(
        `search provider failed: ${err.code}${err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""}: ${err.message}`,
        "SEARCH_ERROR",
        err.code,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new WebResearchError(
      `search provider failed: ${message}`,
      "SEARCH_ERROR",
    );
  }

  if (searchResult.snippets.length === 0) {
    throw new WebResearchError(
      `search provider returned zero snippets for "${queryText}"`,
      "NO_RESULTS",
    );
  }

  // ---- step 2: LLM extraction --------------------------------------------
  let callResult;
  try {
    callResult = await callChat({
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: buildExtractorSystemPrompt() },
        {
          role: "user",
          content: buildExtractorUserMessage(
            opts.component,
            searchResult.snippets,
            opts.clarifications,
          ),
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic Web Research Extractor",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      throw new WebResearchError(
        `OpenRouter extractor call failed: ${err.code}${err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""}: ${err.message}`,
        "OPENROUTER_ERROR",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new WebResearchError(
      `OpenRouter extractor call failed: ${message}`,
      "OPENROUTER_ERROR",
    );
  }

  const payload = parseExtractorResponse(callResult.content);

  const bundle: WebResearchBundle = {
    componentId: opts.component.id,
    mechanism: "web_search",
    proposedDistribution: payload.distribution,
    proposedParams: payload.params,
    reasoning: payload.reasoning,
    citations: payload.citations,
  };

  return {
    bundle,
    model: callResult.model,
    latencyMs: callResult.latencyMs,
    costUsd: callResult.costUsd,
    retryCount: callResult.retryCount,
    snippetCount: searchResult.snippets.length,
    searchProvider: searchResult.provider,
  };
}
