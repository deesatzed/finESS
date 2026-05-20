/**
 * Tavily search provider (Phase B2a).
 *
 * Tavily is the first implementation behind the `SearchProvider`
 * interface defined in `./provider.ts`. Reasoning for choosing Tavily:
 *   - Cheap per-search (well under $0.01 typical).
 *   - JSON-first API designed for LLM downstream consumption.
 *   - Returns a snippet `content` field per result, so we do not need
 *     to scrape pages ourselves.
 *   - Predictable rate limits.
 *
 * API contract (current Tavily endpoint):
 *   POST https://api.tavily.com/search
 *   Body: { api_key, query, max_results, search_depth: "basic" }
 *   Response: {
 *     results: [{ title, url, content, score }, ...],
 *     answer?: string,
 *     query: string,
 *     response_time: number
 *   }
 *
 * The "answer" field is intentionally ignored — the web-research
 * orchestrator (`lib/semantic/research/web.ts`) does the extraction
 * itself with an LLM call so we get distribution params + citations
 * back-references, which Tavily's bare "answer" does not provide.
 *
 * Error mapping (matches the documented contract in provider.ts):
 *   - AbortController timeout         → SearchError("TIMEOUT")
 *   - fetch reject (DNS, socket)      → SearchError("NETWORK")
 *   - HTTP 401                        → SearchError("AUTH")
 *   - HTTP 5xx                        → SearchError("PROVIDER_ERROR")
 *   - Other non-2xx (400, 403, 429)   → SearchError("HTTP_ERROR")
 *   - JSON parse failure              → SearchError("PROVIDER_ERROR")
 *
 * Never throws raw Error or returns null. Never logs the apiKey.
 */

import {
  SearchError,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
  type SearchSnippet,
} from "./provider";

const ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROVIDER_NAME = "tavily";

interface RawTavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

interface RawTavilyResponse {
  results?: unknown;
  /** Tavily occasionally returns response_time in seconds. */
  response_time?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coerceSnippet(raw: unknown, index: number): SearchSnippet | null {
  const rec = asRecord(raw) as RawTavilyResult | null;
  if (!rec) return null;
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (url === "") {
    // A search hit without a URL is useless as a citation; drop it
    // rather than fabricate one.
    return null;
  }
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  const content = typeof rec.content === "string" ? rec.content : "";
  const snippet: SearchSnippet = { title, url, content };
  if (typeof rec.score === "number" && Number.isFinite(rec.score)) {
    snippet.score = rec.score;
  }
  // Suppress unused-index lint without introducing a comment-eslint dep.
  void index;
  return snippet;
}

export const tavilyProvider: SearchProvider = {
  name: PROVIDER_NAME,
  async search(opts: SearchOptions, apiKey: string): Promise<SearchResult> {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new SearchError("Tavily requires a non-empty apiKey", "AUTH");
    }
    if (typeof opts.query !== "string" || opts.query.trim() === "") {
      throw new SearchError("Tavily requires a non-empty query", "HTTP_ERROR");
    }

    const maxResults =
      typeof opts.maxResults === "number" && Number.isFinite(opts.maxResults) && opts.maxResults > 0
        ? Math.floor(opts.maxResults)
        : DEFAULT_MAX_RESULTS;
    const timeoutMs =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new SearchError("global fetch is not available", "NETWORK");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Tavily accepts api_key in either the body or the
          // Authorization header. We use the body form per the
          // current public docs; do not log the header value.
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: opts.query,
          max_results: maxResults,
          search_depth: "basic",
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
      if (isAbort) {
        throw new SearchError(
          `Tavily call timed out after ${timeoutMs}ms`,
          "TIMEOUT",
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SearchError(`Tavily network error: ${message}`, "NETWORK");
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;
    if (status === 401) {
      throw new SearchError("Tavily authentication failed (HTTP 401)", "AUTH", status);
    }
    if (status >= 500) {
      throw new SearchError(`Tavily provider error (HTTP ${status})`, "PROVIDER_ERROR", status);
    }
    if (!response.ok) {
      throw new SearchError(`Tavily HTTP ${status}`, "HTTP_ERROR", status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SearchError(
        `Tavily response was not valid JSON: ${message}`,
        "PROVIDER_ERROR",
        status,
      );
    }

    const raw = asRecord(data) as RawTavilyResponse | null;
    const resultsRaw = raw?.results;
    const snippets: SearchSnippet[] = [];
    if (Array.isArray(resultsRaw)) {
      for (let i = 0; i < resultsRaw.length; i++) {
        const s = coerceSnippet(resultsRaw[i], i);
        if (s) snippets.push(s);
      }
    }

    return {
      snippets,
      latencyMs: Date.now() - startedAt,
      provider: PROVIDER_NAME,
    };
  },
};
