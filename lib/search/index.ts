/**
 * Search provider factory (Phase B2a).
 *
 * Single entry point for getting a SearchProvider implementation.
 * The web-research orchestrator imports `getSearchProvider()` rather
 * than the concrete `tavilyProvider` so swapping in Brave / Bing /
 * Serper later is a one-line change here.
 */

import { tavilyProvider } from "./tavily";
import type { SearchProvider } from "./provider";

export type SupportedSearchProvider = "tavily";

export function getSearchProvider(
  name: SupportedSearchProvider = "tavily",
): SearchProvider {
  switch (name) {
    case "tavily":
      return tavilyProvider;
    default:
      // Exhaustiveness check; if a new provider is added to the type
      // union but not wired here, TS will flag it at compile time.
      // The runtime throw is the belt-and-suspenders.
      throw new Error(`Unknown search provider: ${String(name)}`);
  }
}

export {
  SearchError,
  type SearchOptions,
  type SearchResult,
  type SearchSnippet,
  type SearchProvider,
} from "./provider";
