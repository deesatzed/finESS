/**
 * Semantic Mode B3 — RAG-over-user-documents research orchestrator.
 *
 * Per-component flow:
 *   1. Embed the component's `name + description` into a 384-dim query
 *      vector using the local @xenova/transformers BGE pipeline.
 *   2. Query the workspace's LanceDB table for the top-K nearest chunks.
 *      No web call; no external service. Documents stay local.
 *   3. Hand the retrieved chunks to the configured LLM with an explicit
 *      instruction to: (a) propose a distribution + params consistent
 *      with the component's suggestedDistribution and the chunk evidence
 *      and (b) cite the specific chunk(s) it relied on by documentId +
 *      chunkId. The LLM gets one chance to reply; we validate strictly.
 *   4. Return a `RagResearchBundle` that extends the base
 *      `ResearchBundle` with the citations to local chunks.
 *
 * Citations are local-only: `{ documentId, chunkId, chunkText,
 * sourceFilename }` — there is NO `url` field because these documents
 * never had URLs. The B3 plan explicitly forbids a URL field here.
 *
 * Distribution param shape rules (kept consistent with B1's
 * llm-prior validator so the engine's downstream `sampleDistribution`
 * accepts the output):
 *   - normal:     mean (finite), sd (>0)
 *   - lognormal:  mean (finite), sd (>0)
 *   - uniform:    min (finite), max (>min)
 *   - triangular: min <= mode <= max
 *   - beta:       alpha (>0), beta (>0)
 *
 * Per workspace CLAUDE.md / no-mock rule, this module does not invent
 * params if the LLM fails — it throws RagResearchError with a typed
 * code so the API layer can surface a real failure.
 */

import {
  callChat,
  OpenRouterCallError,
  type CallChatOptions,
} from "@/lib/ai/openrouter-client";
import { embed as embedTexts } from "@/lib/rag/embed";
import { query as queryStore, type QueryHit } from "@/lib/rag/store";
import type {
  ResearchBundle,
  SemanticDistribution,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RagCitation {
  documentId: string;
  chunkId: string;
  chunkText: string;
  sourceFilename: string;
}

/**
 * Extension of `ResearchBundle` carrying the local-only citations.
 * Note: the base ResearchBundle type does NOT have a citations field
 * (per lib/semantic/types.ts); we extend it here so the rag orchestrator
 * can return its richer payload to its direct callers. The API layer
 * decides what subset to forward to the state-machine validator.
 */
export interface RagResearchBundle extends ResearchBundle {
  citations: RagCitation[];
  /** LLM call cost in USD for this orchestrator pass. */
  costUsd: number;
  /** Latency of the LLM call in ms. */
  latencyMs: number;
  /** Number of chunks retrieved from LanceDB before the LLM call. */
  retrievedChunkCount: number;
}

export interface RunRagResearchOptions {
  workspaceId: string;
  component: {
    id: string;
    name: string;
    description: string;
    suggestedDistribution?: SemanticDistribution;
  };
  model: string;
  apiKey: string;
  /** Max chunks to retrieve from LanceDB. Default 5. */
  topK?: number;
  timeoutMs?: number;
  costBudgetUsd?: number;
  /** Test-harness injection. */
  embedImpl?: (texts: string[]) => Promise<number[][]>;
  queryImpl?: (
    workspaceId: string,
    embedding: number[],
    k: number,
  ) => Promise<QueryHit[]>;
  fetchImpl?: CallChatOptions["fetchImpl"];
}

export type RagResearchErrorCode =
  | "EMPTY_COMPONENT"
  | "NO_DOCUMENTS"
  | "EMBED_FAILED"
  | "QUERY_FAILED"
  | "INVALID_RESPONSE"
  | "INVALID_PARAMS"
  | "INVALID_DISTRIBUTION"
  | "INVALID_CITATIONS"
  | "OPENROUTER_ERROR";

export class RagResearchError extends Error {
  readonly code: RagResearchErrorCode;
  constructor(message: string, code: RagResearchErrorCode) {
    super(message);
    this.name = "RagResearchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 5;
const DEFAULT_TEMPERATURE = 0.2;

const VALID_DISTRIBUTIONS: ReadonlySet<SemanticDistribution> = new Set([
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
]);

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildRagSystemPrompt(): string {
  return `You are an expert uncertainty-modeling assistant for finESS.

The user has uploaded reference documents and asked you to model the
uncertainty around one specific component. You will be given:
  - The component's name and description.
  - The component's suggested distribution family (you SHOULD respect
    this unless the document evidence strongly contradicts it; if you
    deviate, explain why in "reasoning").
  - Up to ${DEFAULT_TOP_K} short passages retrieved from the user's local
    documents, each tagged with a documentId and chunkId.

Your job:
  1. Propose a probability distribution and its parameters that best
     reflect the evidence in the retrieved passages.
  2. Explain in 2-4 sentences WHY this distribution + these parameters
     fit the evidence. Reference specific passage facts.
  3. Cite the supporting passages by documentId and chunkId. ONLY cite
     passages you actually used. Do NOT invent citations.

Distribution parameter rules (the model engine validates these strictly;
violations cause your output to be rejected):
  - normal:     { mean: number, sd: number > 0 }
  - lognormal:  { mean: number, sd: number > 0 }
  - uniform:    { min: number, max: number > min }
  - triangular: { min: number, mode: number, max: number } where min <= mode <= max
  - beta:       { alpha: number > 0, beta: number > 0 }

Output STRICT JSON with this shape and NOTHING else:
{
  "distribution": "normal" | "beta" | "uniform" | "lognormal" | "triangular",
  "params": { ... per distribution rules above ... },
  "reasoning": "Why this distribution fits the document evidence.",
  "citations": [
    { "documentId": "<id>", "chunkId": "<id>" }
  ]
}

Citations MUST reference documentId/chunkId pairs from the supplied
passages. Returning a documentId or chunkId that was not in the input
will cause your output to be rejected.

Return ONLY the JSON object. No markdown fences, no prose before or
after.`;
}

export function buildRagUserMessage(
  component: { name: string; description: string; suggestedDistribution?: SemanticDistribution },
  hits: QueryHit[],
): string {
  const passages = hits
    .map(
      (h, i) =>
        `Passage ${i + 1}\n  documentId: ${h.documentId}\n  chunkId: ${h.chunkId}\n  source: ${h.sourceFilename}\n  text: """${truncateForPrompt(h.text)}"""`,
    )
    .join("\n\n");

  const suggested =
    component.suggestedDistribution !== undefined
      ? component.suggestedDistribution
      : "(none — pick the best fit)";

  return `Component: ${component.name}
Description: ${component.description}
Suggested distribution: ${suggested}

Retrieved passages (${hits.length}):

${passages}

Propose the distribution + params + reasoning + citations now.`;
}

/**
 * Truncate a single passage to a sane prompt length (~2000 chars) so a
 * pathologically large chunk can't blow the LLM context window.
 */
function truncateForPrompt(text: string): string {
  const max = 2000;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// Response parsing + validation
// ---------------------------------------------------------------------------

interface RawRagResponse {
  distribution?: unknown;
  params?: unknown;
  reasoning?: unknown;
  citations?: unknown;
}

interface ParsedRagResponse {
  distribution: SemanticDistribution;
  params: Record<string, number>;
  reasoning: string;
  citations: Array<{ documentId: string; chunkId: string }>;
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

export function parseRagResponse(content: string): ParsedRagResponse {
  const cleaned = stripMarkdownFences(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RagResearchError(
      `RAG response is not valid JSON: ${message}`,
      "INVALID_RESPONSE",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RagResearchError(
      "RAG response must be a JSON object",
      "INVALID_RESPONSE",
    );
  }

  const r = parsed as RawRagResponse;

  if (typeof r.distribution !== "string") {
    throw new RagResearchError(
      "RAG response: distribution must be a string",
      "INVALID_RESPONSE",
    );
  }
  if (!VALID_DISTRIBUTIONS.has(r.distribution as SemanticDistribution)) {
    throw new RagResearchError(
      `RAG response: distribution "${r.distribution}" is not supported`,
      "INVALID_DISTRIBUTION",
    );
  }
  const distribution = r.distribution as SemanticDistribution;

  if (typeof r.params !== "object" || r.params === null || Array.isArray(r.params)) {
    throw new RagResearchError(
      "RAG response: params must be an object",
      "INVALID_RESPONSE",
    );
  }
  const params = coerceNumericParams(r.params as Record<string, unknown>);
  validateParamsForDistribution(distribution, params);

  if (typeof r.reasoning !== "string" || r.reasoning.trim() === "") {
    throw new RagResearchError(
      "RAG response: reasoning must be a non-empty string",
      "INVALID_RESPONSE",
    );
  }

  if (!Array.isArray(r.citations)) {
    throw new RagResearchError(
      "RAG response: citations must be an array",
      "INVALID_CITATIONS",
    );
  }
  const citations: Array<{ documentId: string; chunkId: string }> = [];
  for (let i = 0; i < r.citations.length; i++) {
    const c = r.citations[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new RagResearchError(
        `RAG response: citations[${i}] must be an object`,
        "INVALID_CITATIONS",
      );
    }
    const cr = c as Record<string, unknown>;
    if (typeof cr.documentId !== "string" || cr.documentId.trim() === "") {
      throw new RagResearchError(
        `RAG response: citations[${i}].documentId must be a non-empty string`,
        "INVALID_CITATIONS",
      );
    }
    if (typeof cr.chunkId !== "string" || cr.chunkId.trim() === "") {
      throw new RagResearchError(
        `RAG response: citations[${i}].chunkId must be a non-empty string`,
        "INVALID_CITATIONS",
      );
    }
    citations.push({ documentId: cr.documentId, chunkId: cr.chunkId });
  }

  return {
    distribution,
    params,
    reasoning: r.reasoning.trim(),
    citations,
  };
}

function coerceNumericParams(
  raw: Record<string, unknown>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
      else
        throw new RagResearchError(
          `RAG response: params.${key} = "${value}" is not a finite number`,
          "INVALID_PARAMS",
        );
    } else {
      throw new RagResearchError(
        `RAG response: params.${key} must be a finite number, got ${typeof value}`,
        "INVALID_PARAMS",
      );
    }
  }
  return out;
}

function validateParamsForDistribution(
  distribution: SemanticDistribution,
  params: Record<string, number>,
): void {
  switch (distribution) {
    case "normal":
    case "lognormal": {
      if (typeof params.mean !== "number" || !Number.isFinite(params.mean)) {
        throw new RagResearchError(
          `RAG response: ${distribution} requires finite "mean"`,
          "INVALID_PARAMS",
        );
      }
      if (typeof params.sd !== "number" || !Number.isFinite(params.sd) || params.sd <= 0) {
        throw new RagResearchError(
          `RAG response: ${distribution} requires "sd" > 0`,
          "INVALID_PARAMS",
        );
      }
      return;
    }
    case "uniform": {
      if (
        typeof params.min !== "number" ||
        !Number.isFinite(params.min) ||
        typeof params.max !== "number" ||
        !Number.isFinite(params.max)
      ) {
        throw new RagResearchError(
          `RAG response: uniform requires finite "min" and "max"`,
          "INVALID_PARAMS",
        );
      }
      if (params.max <= params.min) {
        throw new RagResearchError(
          `RAG response: uniform requires max > min (got min=${params.min}, max=${params.max})`,
          "INVALID_PARAMS",
        );
      }
      return;
    }
    case "triangular": {
      if (
        typeof params.min !== "number" ||
        !Number.isFinite(params.min) ||
        typeof params.mode !== "number" ||
        !Number.isFinite(params.mode) ||
        typeof params.max !== "number" ||
        !Number.isFinite(params.max)
      ) {
        throw new RagResearchError(
          `RAG response: triangular requires finite "min", "mode", "max"`,
          "INVALID_PARAMS",
        );
      }
      if (!(params.min <= params.mode && params.mode <= params.max)) {
        throw new RagResearchError(
          `RAG response: triangular requires min <= mode <= max (got ${params.min}, ${params.mode}, ${params.max})`,
          "INVALID_PARAMS",
        );
      }
      return;
    }
    case "beta": {
      if (typeof params.alpha !== "number" || !Number.isFinite(params.alpha) || params.alpha <= 0) {
        throw new RagResearchError(
          `RAG response: beta requires alpha > 0`,
          "INVALID_PARAMS",
        );
      }
      if (typeof params.beta !== "number" || !Number.isFinite(params.beta) || params.beta <= 0) {
        throw new RagResearchError(
          `RAG response: beta requires beta > 0`,
          "INVALID_PARAMS",
        );
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runRagResearch(
  opts: RunRagResearchOptions,
): Promise<RagResearchBundle> {
  if (!opts.workspaceId || opts.workspaceId.trim() === "") {
    throw new RagResearchError(
      "runRagResearch: workspaceId is required",
      "EMPTY_COMPONENT",
    );
  }
  if (!opts.component || !opts.component.id || !opts.component.name) {
    throw new RagResearchError(
      "runRagResearch: component.id and component.name are required",
      "EMPTY_COMPONENT",
    );
  }
  if (!opts.model || opts.model.trim() === "") {
    throw new RagResearchError(
      "runRagResearch: model is required (user-supplied)",
      "OPENROUTER_ERROR",
    );
  }
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new RagResearchError(
      "runRagResearch: apiKey is required",
      "OPENROUTER_ERROR",
    );
  }

  const topK = opts.topK ?? DEFAULT_TOP_K;
  const embedFn = opts.embedImpl ?? embedTexts;
  const queryFn = opts.queryImpl ?? queryStore;

  // Step 1: embed the component name + description.
  const queryText = `${opts.component.name}\n${opts.component.description}`.trim();
  let embeddings: number[][];
  try {
    embeddings = await embedFn([queryText]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RagResearchError(
      `Embedding failed: ${message}`,
      "EMBED_FAILED",
    );
  }
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new RagResearchError(
      "Embedding adapter returned no vectors",
      "EMBED_FAILED",
    );
  }
  const queryVector = embeddings[0];

  // Step 2: query LanceDB for top-K nearest chunks.
  let hits: QueryHit[];
  try {
    hits = await queryFn(opts.workspaceId, queryVector, topK);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RagResearchError(
      `Vector store query failed: ${message}`,
      "QUERY_FAILED",
    );
  }

  if (!Array.isArray(hits) || hits.length === 0) {
    throw new RagResearchError(
      "No documents have been uploaded to this workspace yet; RAG research requires at least one indexed document",
      "NO_DOCUMENTS",
    );
  }

  // Step 3: call the LLM with retrieved chunks.
  let callResult;
  try {
    callResult = await callChat({
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: buildRagSystemPrompt() },
        {
          role: "user",
          content: buildRagUserMessage(opts.component, hits),
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic RAG Research",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      throw new RagResearchError(
        `OpenRouter call failed: ${err.code}${err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""}: ${err.message}`,
        "OPENROUTER_ERROR",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RagResearchError(
      `OpenRouter call failed: ${message}`,
      "OPENROUTER_ERROR",
    );
  }

  // Step 4: parse + validate response.
  const parsed = parseRagResponse(callResult.content);

  // Cross-reference citations against the retrieved chunk set so the
  // LLM cannot invent documentId/chunkId pairs. Reject the whole bundle
  // if any citation points to a chunk we didn't surface.
  const hitMap = new Map<string, QueryHit>();
  for (const h of hits) {
    hitMap.set(`${h.documentId}::${h.chunkId}`, h);
  }
  const richCitations: RagCitation[] = [];
  for (const c of parsed.citations) {
    const key = `${c.documentId}::${c.chunkId}`;
    const hit = hitMap.get(key);
    if (!hit) {
      throw new RagResearchError(
        `RAG response cites unknown chunk ${key} — not among the retrieved passages`,
        "INVALID_CITATIONS",
      );
    }
    richCitations.push({
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      chunkText: hit.text,
      sourceFilename: hit.sourceFilename,
    });
  }

  if (richCitations.length === 0) {
    throw new RagResearchError(
      "RAG response returned zero citations; at least one is required",
      "INVALID_CITATIONS",
    );
  }

  const bundle: RagResearchBundle = {
    componentId: opts.component.id,
    mechanism: "rag_document",
    proposedDistribution: parsed.distribution,
    proposedParams: parsed.params,
    reasoning: parsed.reasoning,
    citations: richCitations,
    costUsd: callResult.costUsd,
    latencyMs: callResult.latencyMs,
    retrievedChunkCount: hits.length,
  };
  return bundle;
}
