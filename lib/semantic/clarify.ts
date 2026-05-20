/**
 * Semantic Mode — Step A3: clarifying-questions adapter.
 *
 * Given a user's natural-language question, ask the configured LLM to
 * surface 2-5 clarifying questions whose answers would meaningfully
 * change how the uncertainty model is built. This is the first LLM step
 * in the Semantic Mode pipeline; its output is consumed by the state
 * machine via the `clarificationsReceived` event (see
 * `lib/semantic/state-machine.ts`).
 *
 * Design decisions:
 *  1. Every LLM call goes through `lib/ai/openrouter-client.ts` so the
 *     project-wide timeout, single-retry, and per-call cost ceiling are
 *     enforced uniformly. This module never speaks `fetch` directly.
 *  2. The system prompt embeds two worked examples (one product /
 *     non-clinical, one clinical) per the v2 addendum's mandatory
 *     few-shot rule. Empirically the absence of a few-shot regressed
 *     analogous LLM outputs to flat / generic results (v2 plan change-
 *     row 6); the same risk applies to clarifying-question quality.
 *  3. We do NOT pre-select which example to show based on the query.
 *     The clarifier's job is exactly to surface what is unstated, so
 *     bias-by-domain-pick would defeat the purpose. Both examples are
 *     always inlined; the LLM picks up the pattern, not the domain.
 *  4. Validation is strict and explicit: malformed JSON, wrong shape,
 *     or out-of-range counts each map to a distinct `ClarifyError.code`
 *     so the UI (and any callers / persisters) can show actionable
 *     messages. Pattern mirrors `lib/ai/parse-response.ts` (typed
 *     throws on bad LLM output).
 *  5. `OpenRouterCallError` is wrapped in `ClarifyError("OPENROUTER_ERROR")`
 *     so callers only need to import one error type from this module.
 *  6. The model id is always caller-supplied; this module never reads
 *     any default model from env. Per workspace CLAUDE.md the user
 *     selects all model versions.
 */

import {
  callChat,
  OpenRouterCallError,
} from "@/lib/ai/openrouter-client";
import clarifierExamples from "@/lib/ai/examples/clarifier-examples.json";
import type { ClarifyingQuestion } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RequestClarificationsOptions {
  query: string;
  model: string;
  apiKey: string;
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number;
  /** Optional per-call cost ceiling override (USD). */
  costBudgetUsd?: number;
  /** Test-harness fetch injection only; production passes nothing. */
  fetchImpl?: typeof fetch;
}

export interface ClarifyResult {
  questions: ClarifyingQuestion[];
  model: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export type ClarifyErrorCode =
  | "EMPTY_QUERY"
  | "INVALID_RESPONSE"
  | "TOO_FEW_QUESTIONS"
  | "TOO_MANY_QUESTIONS"
  | "OPENROUTER_ERROR";

export class ClarifyError extends Error {
  readonly code: ClarifyErrorCode;

  constructor(message: string, code: ClarifyErrorCode) {
    super(message);
    this.name = "ClarifyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 5;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface ClarifierExampleFile {
  examples: ReadonlyArray<{
    domain: string;
    userQuery: string;
    response: unknown;
  }>;
}

function renderExamples(): string {
  const file = clarifierExamples as unknown as ClarifierExampleFile;
  return file.examples
    .map(
      (ex) =>
        `User question: "${ex.userQuery}"\nGood response:\n${JSON.stringify(
          ex.response,
          null,
          2
        )}`
    )
    .join("\n\n");
}

/**
 * Build the system prompt for the clarifier call. Inlines BOTH worked
 * examples so the LLM internalizes the pattern (short question +
 * plain-language why + optional default) rather than the domain.
 */
export function buildClarifierSystemPrompt(): string {
  return `You are an expert uncertainty-modeling assistant for finESS.

A user has asked you to help model the uncertainty around a real decision.
Your job in THIS step is NOT to model anything yet. Your job is to ask
${MIN_QUESTIONS}-${MAX_QUESTIONS} clarifying questions whose answers would
meaningfully change how you model the problem.

GOOD clarifying questions:
- Surface unstated context (time horizon, geographic scope, scale).
- Distinguish between similar-sounding scenarios (e.g. "growth" could
  mean revenue, users, headcount).
- Identify the operator's actual decision (what action does this inform?).
- Pin down domain-specific values the user might assume the assistant
  already knows (specific regulations, populations, market segments).

BAD clarifying questions (do NOT ask):
- Statistical jargon (don't ask about distributions, confidence intervals,
  Monte Carlo). The user is non-statistical.
- Things you could reasonably infer from context.
- Questions about data formats or tooling.

Output strict JSON with this shape and nothing else:
{
  "questions": [
    { "id": "q1", "question": "...", "why": "...", "defaultAnswer": "..." (optional) },
    ...
  ]
}

Return between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions inclusive.
Each question's "why" must be one short sentence in plain language.
If you include "defaultAnswer", it must be a plain-language fallback the
user could literally accept verbatim. Omit it if a sensible default would
mislead the analysis.

WORKED EXAMPLES

${renderExamples()}

Return ONLY the JSON object. No prose before or after.`;
}

function buildClarifierUserMessage(query: string): string {
  return query;
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

interface RawQuestion {
  id?: unknown;
  question?: unknown;
  why?: unknown;
  defaultAnswer?: unknown;
}

function stripMarkdownFences(raw: string): string {
  // OpenRouter occasionally wraps response_format=json_object content in
  // markdown fences despite the response-format hint. Mirror the
  // parse-response strip so we don't reject valid-looking JSON.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }
  return cleaned;
}

/**
 * Validate one raw question record. Returns the typed `ClarifyingQuestion`
 * on success. Throws `ClarifyError("INVALID_RESPONSE")` naming the bad
 * index on failure.
 */
function validateAndCoerceQuestion(
  raw: unknown,
  index: number,
): ClarifyingQuestion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClarifyError(
      `clarifier response: question at index ${index} is not an object`,
      "INVALID_RESPONSE",
    );
  }
  const r = raw as RawQuestion;

  // `question` is required and non-empty.
  if (typeof r.question !== "string" || r.question.trim() === "") {
    throw new ClarifyError(
      `clarifier response: question at index ${index} is missing required non-empty "question" field`,
      "INVALID_RESPONSE",
    );
  }

  // `id` is preferred from the LLM but synthesized stably from the
  // 1-based ordinal if missing or non-string-non-empty. This keeps the
  // ClarifyingQuestion contract (id always set) without rejecting a
  // response purely for an omitted id, which the LLM might forget under
  // load even with the schema example.
  let id: string;
  if (typeof r.id === "string" && r.id.trim() !== "") {
    id = r.id.trim();
  } else {
    id = `q${index + 1}`;
  }

  const out: ClarifyingQuestion = { id, question: r.question.trim() };

  if (typeof r.why === "string" && r.why.trim() !== "") {
    out.why = r.why.trim();
  }
  if (typeof r.defaultAnswer === "string" && r.defaultAnswer.trim() !== "") {
    out.defaultAnswer = r.defaultAnswer.trim();
  }

  return out;
}

/**
 * Parse the LLM-returned JSON string into a typed list of questions.
 * Throws specific `ClarifyError` codes for each failure mode the UI
 * needs to distinguish.
 */
export function parseClarifyingResponse(
  content: string,
): ClarifyingQuestion[] {
  const cleaned = stripMarkdownFences(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ClarifyError(
      `clarifier response is not valid JSON: ${message}`,
      "INVALID_RESPONSE",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClarifyError(
      "clarifier response must be a JSON object with a 'questions' array",
      "INVALID_RESPONSE",
    );
  }

  const root = parsed as Record<string, unknown>;
  const questionsRaw = root.questions;
  if (!Array.isArray(questionsRaw)) {
    throw new ClarifyError(
      "clarifier response is missing required 'questions' array",
      "INVALID_RESPONSE",
    );
  }

  if (questionsRaw.length < MIN_QUESTIONS) {
    throw new ClarifyError(
      `clarifier response has too few questions: got ${questionsRaw.length}, need at least ${MIN_QUESTIONS}`,
      "TOO_FEW_QUESTIONS",
    );
  }
  if (questionsRaw.length > MAX_QUESTIONS) {
    throw new ClarifyError(
      `clarifier response has too many questions: got ${questionsRaw.length}, max ${MAX_QUESTIONS}`,
      "TOO_MANY_QUESTIONS",
    );
  }

  const out: ClarifyingQuestion[] = [];
  for (let i = 0; i < questionsRaw.length; i++) {
    out.push(validateAndCoerceQuestion(questionsRaw[i], i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function requestClarifications(
  opts: RequestClarificationsOptions,
): Promise<ClarifyResult> {
  // Step 1: validate the query up front so we never spend a token on an
  // empty input.
  if (typeof opts.query !== "string" || opts.query.trim() === "") {
    throw new ClarifyError(
      "requestClarifications requires a non-empty query",
      "EMPTY_QUERY",
    );
  }
  if (typeof opts.model !== "string" || opts.model.trim() === "") {
    throw new ClarifyError(
      "requestClarifications requires a non-empty model id (user-supplied; never hardcoded)",
      "OPENROUTER_ERROR",
    );
  }
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
    throw new ClarifyError(
      "requestClarifications requires a non-empty apiKey",
      "OPENROUTER_ERROR",
    );
  }

  // Step 2: call the LLM through the centralized wrapper.
  let callResult;
  try {
    callResult = await callChat({
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: buildClarifierSystemPrompt() },
        { role: "user", content: buildClarifierUserMessage(opts.query) },
      ],
      responseFormat: { type: "json_object" },
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic Clarify",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      throw new ClarifyError(
        `OpenRouter call failed: ${err.code}${
          err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""
        }: ${err.message}`,
        "OPENROUTER_ERROR",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ClarifyError(
      `OpenRouter call failed: ${message}`,
      "OPENROUTER_ERROR",
    );
  }

  // Step 3: parse + validate. parseClarifyingResponse throws typed
  // ClarifyError codes the UI can distinguish.
  const questions = parseClarifyingResponse(callResult.content);

  return {
    questions,
    model: callResult.model,
    latencyMs: callResult.latencyMs,
    costUsd: callResult.costUsd,
    retryCount: callResult.retryCount,
  };
}
