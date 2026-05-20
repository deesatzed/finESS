/**
 * Search provider abstraction (Phase B2a).
 *
 * The web-search research mechanism (`lib/semantic/research/web.ts`) does
 * NOT couple to any specific search vendor. Instead it depends on the
 * `SearchProvider` interface defined here. Today the only implementation
 * is Tavily (`lib/search/tavily.ts`); a Brave / Bing / Serper provider
 * can drop in later without touching the orchestrator.
 *
 * Why a typed error class instead of returning Result<T, E>:
 *   The rest of the codebase (OpenRouterCallError, ClarifyError,
 *   ProposeComponentsError) throws typed errors so route handlers and
 *   higher-level orchestrators can map them with a single try/catch +
 *   `instanceof` check. Keeping the convention here avoids a one-off
 *   pattern that callers would have to special-case.
 *
 * Error code semantics (must match across all provider implementations):
 *   - TIMEOUT          : caller-supplied timeout elapsed before any HTTP response.
 *   - HTTP_ERROR       : non-2xx response that is not 401 or 5xx (e.g. 400 bad
 *                        request, 403 forbidden, 429 rate-limited).
 *   - AUTH             : 401 unauthorized — the apiKey is invalid or missing.
 *   - PROVIDER_ERROR   : 5xx response — the provider failed server-side.
 *   - NETWORK          : DNS / connect / socket failure before any HTTP
 *                        status was observed. Distinct from TIMEOUT so the
 *                        UI can tell "offline" from "slow".
 */

export interface SearchSnippet {
  /** Human-readable page title from the provider. May be empty for some results. */
  title: string;
  /** Canonical URL of the source. The orchestrator uses this verbatim as the citation. */
  url: string;
  /** Snippet body returned by the provider. NOT the full page — providers truncate. */
  content: string;
  /** Provider relevance score in [0, 1] when available. Optional because not every provider supplies one. */
  score?: number;
}

export interface SearchOptions {
  query: string;
  /** Hard cap on returned snippets. Defaults to 5 inside the provider. */
  maxResults?: number;
  /** Per-call wall-clock timeout (ms). Defaults to 15000 inside the provider. */
  timeoutMs?: number;
  /** Test-harness fetch injection only; production passes nothing. */
  fetchImpl?: typeof fetch;
}

export interface SearchResult {
  snippets: SearchSnippet[];
  /** Provider's reported total-results count when available (Tavily does not always supply this). */
  totalResults?: number;
  latencyMs: number;
  /** Stable provider identifier (e.g. "tavily"). Used downstream for audit/UI. */
  provider: string;
}

export type SearchErrorCode =
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "AUTH"
  | "PROVIDER_ERROR"
  | "NETWORK";

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly httpStatus?: number;

  constructor(message: string, code: SearchErrorCode, httpStatus?: number) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * A pluggable search provider. Implementations MUST:
 *   - Honor `opts.timeoutMs` (AbortController-style cancellation).
 *   - Throw `SearchError` with the correct code on failure.
 *   - Return `snippets: []` (not throw) when the provider returns
 *     zero results for a valid query — the orchestrator decides
 *     whether "no results" is fatal.
 *   - Stamp `provider` and `latencyMs` on the result for audit/UI.
 */
export interface SearchProvider {
  readonly name: string;
  search(opts: SearchOptions, apiKey: string): Promise<SearchResult>;
}
