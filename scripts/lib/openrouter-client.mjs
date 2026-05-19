// ESM mirror of lib/ai/openrouter-client.ts. Same contract: timeout, single
// retry on 5xx / network / timeout, per-call cost budget enforcement, no
// max_tokens. Kept in sync manually because .mjs cannot import .ts directly
// without bringing a TS transpiler into the script runner. If you change
// semantics in lib/ai/openrouter-client.ts, update this file too.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PER_CALL_BUDGET_USD = 0.05;
const RETRY_BACKOFF_MS = 500;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterCallError extends Error {
  constructor(message, code, httpStatus, latencyMs, costUsd) {
    super(message);
    this.name = "OpenRouterCallError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.latencyMs = latencyMs;
    this.costUsd = costUsd;
  }
}

function resolveTimeoutMs(explicit) {
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

function resolveBudgetUsd(explicit) {
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

function buildRequestInit(opts, signal) {
  const body = {
    model: opts.model,
    messages: opts.messages,
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

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

async function attempt(opts, fetchImpl, timeoutMs, callerSignal) {
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
      error && (error.name === "AbortError" || /aborted/i.test(error.message ?? ""));
    if (isAbort) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callChat(opts) {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new OpenRouterCallError("callChat requires a non-empty apiKey", "NETWORK");
  }
  if (!opts.model || opts.model.trim() === "") {
    throw new OpenRouterCallError("callChat requires a non-empty model", "NETWORK");
  }
  if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
    throw new OpenRouterCallError("callChat requires at least one message", "NETWORK");
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new OpenRouterCallError("global fetch is not available", "NETWORK");
  }

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const budgetUsd = resolveBudgetUsd(opts.costBudgetUsd);

  const overallStart = Date.now();
  let retryCount = 0;
  let lastError;
  let response;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++) {
    const outcome = await attempt(opts, fetchImpl, timeoutMs, opts.signal);
    if (outcome.kind === "ok") {
      response = outcome.response;
      break;
    }
    lastError = outcome.error;
    if (outcome.kind === "fatal") throw outcome.error;
    if (attemptIndex === 0) {
      retryCount = 1;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw lastError;
  }

  if (!response) {
    throw lastError ?? new OpenRouterCallError("Unknown OpenRouter failure", "NETWORK");
  }

  let data;
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

  const choice = data?.choices?.[0]?.message ?? {};
  const rawContent = choice.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : undefined;
  const rawCost = data?.usage?.cost;
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;
  const reportedModel =
    typeof data?.model === "string" && data.model.trim() !== "" ? data.model : opts.model;
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
