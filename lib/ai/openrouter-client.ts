/**
 * Single funnel for every OpenRouter chat-completions call.
 *
 * Why this exists:
 *   A misrouted reasoning model with no timeout, no budget, and no retry policy
 *   can run for minutes and rack up real cost per request. This wrapper enforces
 *   a per-call wall-clock timeout, single-shot retry-on-transient-failure, and a
 *   per-call cost ceiling read from env (caller may override). Every API route
 *   that talks to OpenRouter MUST go through this function.
 *
 * Source-of-truth note:
 *   A near-identical .mjs mirror lives at scripts/lib/openrouter-client.mjs for
 *   the .mjs-only smoke / preflight scripts. The two files must enforce the
 *   same contract — if you change semantics here, update the mirror.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PER_CALL_BUDGET_USD = 0.05;
const RETRY_BACKOFF_MS = 500;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type CallChatErrorCode =
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "BUDGET_EXCEEDED"
  | "EMPTY_RESPONSE"
  | "NETWORK";

export interface CallChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallChatOptions {
  model: string;
  apiKey: string;
  messages: CallChatMessage[];
  responseFormat?: { type: "json_object" };
  temperature?: number;
  timeoutMs?: number;
  costBudgetUsd?: number;
  referer?: string;
  title?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface CallChatResult {
  content: string;
  toolCalls?: unknown[];
  model: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export class OpenRouterCallError extends Error {
  readonly code: CallChatErrorCode;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
  readonly costUsd?: number;

  constructor(
    message: string,
    code: CallChatErrorCode,
    httpStatus?: number,
    latencyMs?: number,
    costUsd?: number
  ) {
    super(message);
    this.name = "OpenRouterCallError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.latencyMs = latencyMs;
    this.costUsd = costUsd;
  }
}

function resolveTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  if (raw && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveBudgetUsd(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const raw = process.env.OPENROUTER_PER_CALL_BUDGET_USD;
  if (raw && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_PER_CALL_BUDGET_USD;
}

function buildRequestInit(
  opts: CallChatOptions,
  signal: AbortSignal
): RequestInit {
  // Note: we intentionally omit max_tokens — project rule: reasoning models
  // must have full output-token headroom or they truncate JSON.
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  if (typeof opts.temperature === "number") {
    body.temperature = opts.temperature;
  }
  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }

  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": opts.referer ?? "https://finess.app",
      "X-Title": opts.title ?? "finESS",
    },
    body: JSON.stringify(body),
    signal,
  };
}

interface AttemptOutcome {
  kind: "ok" | "retryable" | "fatal";
  response?: Response;
  error?: OpenRouterCallError;
}

async function attempt(
  opts: CallChatOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(ENDPOINT, buildRequestInit(opts, controller.signal));
    if (response.status >= 500) {
      return {
        kind: "retryable",
        error: new OpenRouterCallError(
          `OpenRouter HTTP ${response.status}`,
          "HTTP_ERROR",
          response.status,
          Date.now() - startedAt
        ),
      };
    }
    if (!response.ok) {
      return {
        kind: "fatal",
        error: new OpenRouterCallError(
          `OpenRouter HTTP ${response.status}`,
          "HTTP_ERROR",
          response.status,
          Date.now() - startedAt
        ),
      };
    }
    return { kind: "ok", response };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    if (isAbort) {
      // Caller-driven aborts are not retryable; timer-driven aborts are TIMEOUT.
      if (callerSignal?.aborted) {
        return {
          kind: "fatal",
          error: new OpenRouterCallError("Caller aborted", "NETWORK", undefined, latencyMs),
        };
      }
      return {
        kind: "retryable",
        error: new OpenRouterCallError(
          `OpenRouter call timed out after ${timeoutMs}ms`,
          "TIMEOUT",
          undefined,
          latencyMs
        ),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "retryable",
      error: new OpenRouterCallError(`Network error: ${message}`, "NETWORK", undefined, latencyMs),
    };
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ParsedChoice {
  content: string;
  toolCalls?: unknown[];
}

function extractChoice(data: unknown): ParsedChoice {
  const root = asRecord(data);
  const choicesRaw = root?.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    return { content: "" };
  }
  const firstChoice = asRecord(choicesRaw[0]);
  const message = asRecord(firstChoice?.message);
  if (!message) return { content: "" };
  const rawContent = message.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  const rawTools = message.tool_calls;
  const toolCalls = Array.isArray(rawTools) ? (rawTools as unknown[]) : undefined;
  return { content, toolCalls };
}

function extractCostUsd(data: unknown): number {
  const usage = asRecord(asRecord(data)?.usage);
  const rawCost = usage?.cost;
  return typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;
}

function extractReportedModel(data: unknown, fallback: string): string {
  const root = asRecord(data);
  const reported = root?.model;
  return typeof reported === "string" && reported.trim() !== "" ? reported : fallback;
}

export async function callChat(opts: CallChatOptions): Promise<CallChatResult> {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new OpenRouterCallError(
      "callChat requires a non-empty apiKey",
      "NETWORK"
    );
  }
  if (!opts.model || opts.model.trim() === "") {
    throw new OpenRouterCallError("callChat requires a non-empty model", "NETWORK");
  }
  if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
    throw new OpenRouterCallError(
      "callChat requires at least one message",
      "NETWORK"
    );
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OpenRouterCallError("global fetch is not available", "NETWORK");
  }

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const budgetUsd = resolveBudgetUsd(opts.costBudgetUsd);

  const overallStart = Date.now();
  let retryCount = 0;
  let lastError: OpenRouterCallError | undefined;
  let response: Response | undefined;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++) {
    const outcome = await attempt(opts, fetchImpl, timeoutMs, opts.signal);
    if (outcome.kind === "ok") {
      response = outcome.response;
      break;
    }
    lastError = outcome.error;
    if (outcome.kind === "fatal") {
      throw outcome.error as OpenRouterCallError;
    }
    if (attemptIndex === 0) {
      retryCount = 1;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw lastError as OpenRouterCallError;
  }

  if (!response) {
    throw lastError ?? new OpenRouterCallError("Unknown OpenRouter failure", "NETWORK");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenRouterCallError(
      `OpenRouter response was not valid JSON: ${message}`,
      "EMPTY_RESPONSE",
      response.status,
      Date.now() - overallStart
    );
  }

  const { content, toolCalls } = extractChoice(data);
  const costUsd = extractCostUsd(data);
  const reportedModel = extractReportedModel(data, opts.model);
  const latencyMs = Date.now() - overallStart;

  const hasContent = content.trim() !== "";
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (!hasContent && !hasToolCalls) {
    throw new OpenRouterCallError(
      "OpenRouter returned empty content and no tool_calls",
      "EMPTY_RESPONSE",
      response.status,
      latencyMs,
      costUsd
    );
  }

  if (budgetUsd > 0 && costUsd > budgetUsd) {
    throw new OpenRouterCallError(
      `OpenRouter call cost $${costUsd.toFixed(4)} exceeded per-call budget $${budgetUsd.toFixed(4)}`,
      "BUDGET_EXCEEDED",
      response.status,
      latencyMs,
      costUsd
    );
  }

  return {
    content,
    toolCalls,
    model: reportedModel,
    latencyMs,
    costUsd,
    retryCount,
  };
}
