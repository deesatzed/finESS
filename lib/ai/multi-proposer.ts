/**
 * R6-02 — Multi-LLM proposal lane (proposeGraphs).
 *
 * Why this exists:
 *   The existing Path A handler issues a single LLM call → gets one graph.
 *   The biggest source of uncertainty in any single-LLM output is between-
 *   model variance, which is invisible when only one model is consulted.
 *   This module dispatches the same query to N configured models in parallel
 *   and returns each model's outcome side-by-side. Per-model failures are
 *   isolated so that one bad proposer never aborts the others — the whole
 *   point is that the UI can show the human "model A says X, model B says Y;
 *   pick the one closest to your data and edit it."
 *
 * Contract:
 *   - Every LLM call MUST go through the centralized `callChat` wrapper
 *     (timeout, retry, cost ceiling enforced there).
 *   - Per-proposer errors do NOT throw; they become `error` strings on the
 *     result object so the UI can render disagreement honestly.
 *   - Results are returned in the same order as the input `models` list so
 *     downstream UI is deterministic.
 *   - Default model list comes from `getConfiguredModels()` — never hard-code
 *     a model id. The user selects model versions, always.
 *
 * Concurrency:
 *   We bound parallelism with a small worker-pool loop (default 3, override
 *   with env `OPENROUTER_PROPOSER_CONCURRENCY` or `options.concurrencyLimit`).
 *   This balances "use parallelism to keep wall-time bounded" against "don't
 *   hammer the upstream with N parallel requests on every page load".
 */

import {
  callChat,
  OpenRouterCallError,
  type CallChatOptions,
} from "@/lib/ai/openrouter-client";
import { buildSystemPrompt, buildUserMessage } from "@/lib/ai/prompt";
import { parseAIResponse } from "@/lib/ai/parse-response";
import { getConfiguredModels } from "@/lib/ai/model-config";
import type { UncertaintyGraph } from "@/lib/types";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TEMPERATURE = 0.7;

export interface ProposalResult {
  model: string;
  graph?: UncertaintyGraph;
  /** Human-readable error if this proposer failed. */
  error?: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export interface MultiProposalOptions {
  query: string;
  apiKey: string;
  /** 1..N model IDs; defaults to all configured models if empty/undefined. */
  models?: string[];
  /** Defaults from env OPENROUTER_PROPOSER_CONCURRENCY or 3. */
  concurrencyLimit?: number;
  /** Test-harness injection only; production code passes nothing. */
  fetchImpl?: CallChatOptions["fetchImpl"];
}

function resolveConcurrency(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const raw = process.env.OPENROUTER_PROPOSER_CONCURRENCY;
  if (raw && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_CONCURRENCY;
}

function resolveModels(input?: string[]): string[] {
  if (Array.isArray(input) && input.length > 0) {
    const cleaned = input
      .map((m) => (typeof m === "string" ? m.trim() : ""))
      .filter((m) => m !== "");
    if (cleaned.length > 0) return cleaned;
  }
  const configured = getConfiguredModels().models;
  return configured.map((m) => m.id).filter((id) => id.trim() !== "");
}

function describeError(err: OpenRouterCallError): string {
  if (err.httpStatus !== undefined) {
    return `${err.code} HTTP ${err.httpStatus}`;
  }
  return err.code;
}

async function runOneProposer(
  model: string,
  opts: MultiProposalOptions
): Promise<ProposalResult> {
  const startedAt = Date.now();
  let callResult;
  try {
    callResult = await callChat({
      model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: buildSystemPrompt(opts.query) },
        { role: "user", content: buildUserMessage(opts.query) },
      ],
      temperature: DEFAULT_TEMPERATURE,
      referer: "https://finess.app",
      title: "finESS Multi-Proposer",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      return {
        model,
        error: describeError(err),
        latencyMs: err.latencyMs ?? Date.now() - startedAt,
        costUsd: err.costUsd ?? 0,
        retryCount: 0,
      };
    }
    // Unknown errors are still isolated so one rogue proposer cannot abort
    // the rest of the batch.
    const message = err instanceof Error ? err.message : String(err);
    return {
      model,
      error: `UNKNOWN ${message}`,
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
    const graph = parseAIResponse(content);
    return { model, graph, latencyMs, costUsd, retryCount };
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return {
      model,
      error: `PARSE_FAILED: ${message}`,
      latencyMs,
      costUsd,
      retryCount,
    };
  }
}

export async function proposeGraphs(
  opts: MultiProposalOptions
): Promise<ProposalResult[]> {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new Error("proposeGraphs requires a non-empty apiKey");
  }
  if (typeof opts.query !== "string" || opts.query.trim() === "") {
    throw new Error("proposeGraphs requires a non-empty query");
  }

  const models = resolveModels(opts.models);
  if (models.length === 0) {
    throw new Error(
      "proposeGraphs has no models to call (pass models or configure OPENROUTER_MODELS)"
    );
  }
  const concurrency = resolveConcurrency(opts.concurrencyLimit);

  // Preserve input order for deterministic UI rendering.
  const results: ProposalResult[] = new Array(models.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= models.length) return;
      results[i] = await runOneProposer(models[i], opts);
    }
  }

  const workerCount = Math.min(concurrency, models.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  return results;
}
