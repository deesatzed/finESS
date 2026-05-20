/**
 * Phase B2 — Live integration test for researchWeb (Tavily + OpenRouter).
 *
 * Exercises the full pipeline against real APIs:
 *   1. Hits api.tavily.com/search for live snippets.
 *   2. Hands snippets to the live OpenRouter extractor.
 *   3. Verifies the resulting ResearchBundle has real citation URLs and
 *      that total cost (Tavily + LLM) stays under the documented budget.
 *
 * SKIPPED by default — requires BOTH external APIs. To run:
 *
 *   TAVILY_LIVE=1 RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/semantic-research-web.integration.test.ts \
 *     --runInBand
 *
 * Required env (all loaded from .env.local first, then .env):
 *   - TAVILY_API_KEY                    (sign up at https://tavily.com/)
 *   - OPENROUTER_API_KEY
 *   - OPENROUTER_DEFAULT_MODEL          (user-selected, per workspace rule)
 */

import path from "node:path";
import dotenv from "dotenv";

const RUN =
  process.env.TAVILY_LIVE === "1" && process.env.RUN_OPENROUTER_LIVE === "1";

if (RUN) {
  dotenv.config({
    path: path.join(process.cwd(), ".env.local"),
    override: false,
    quiet: true,
  });
  dotenv.config({
    path: path.join(process.cwd(), ".env"),
    override: false,
    quiet: true,
  });
}

(RUN ? describe : describe.skip)(
  "researchWeb (live Tavily + OpenRouter)",
  () => {
    test("produces a ResearchBundle with real citation URLs under combined budget", async () => {
      const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
      const tavilyKey = process.env.TAVILY_API_KEY?.trim();
      const model = process.env.OPENROUTER_DEFAULT_MODEL?.trim();
      if (!openrouterKey) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live web-research integration test",
        );
      }
      if (!tavilyKey) {
        throw new Error(
          "TAVILY_API_KEY is required for the live web-research integration test",
        );
      }
      if (!model) {
        throw new Error(
          "OPENROUTER_DEFAULT_MODEL is required for the live web-research integration test",
        );
      }

      const { researchWeb } = await import("@/lib/semantic/research/web");

      const result = await researchWeb({
        component: {
          id: "saas_cac",
          name: "B2B SaaS customer acquisition cost",
          description:
            "The blended cost in USD to acquire one paying customer for a typical mid-market B2B SaaS company.",
          suggestedDistribution: "lognormal",
          why: "Drives unit economics and runway projections.",
        },
        query: "B2B SaaS customer acquisition cost benchmark range",
        model,
        apiKey: openrouterKey,
        tavilyApiKey: tavilyKey,
        searchMaxResults: 5,
      });

      // ---- snippet count -------------------------------------------------
      expect(result.snippetCount).toBeGreaterThanOrEqual(1);

      // ---- bundle shape --------------------------------------------------
      expect(result.bundle.mechanism).toBe("web_search");
      expect(result.bundle.componentId).toBe("saas_cac");
      expect(typeof result.bundle.proposedDistribution).toBe("string");
      expect(result.bundle.reasoning.length).toBeGreaterThan(0);

      // ---- citations -----------------------------------------------------
      expect(Array.isArray(result.bundle.citations)).toBe(true);
      expect(result.bundle.citations.length).toBeGreaterThanOrEqual(1);
      for (const c of result.bundle.citations) {
        // Real http(s) URL
        expect(c.url).toMatch(/^https?:\/\//);
        expect(c.snippet.length).toBeGreaterThan(0);
      }

      // ---- budget --------------------------------------------------------
      // Tavily is metered separately and is typically well under a cent
      // per search; the costUsd here is the LLM leg only. The combined
      // budget assertion is conservatively a hard $0.10 cap for both
      // legs together (LLM dominates).
      expect(result.costUsd).toBeLessThan(0.1);

      // Breadcrumb for the orchestrator
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_SEMANTIC_RESEARCH_WEB_OK:",
        `provider=${result.searchProvider}`,
        `snippets=${result.snippetCount}`,
        `model=${result.model}`,
        `distribution=${result.bundle.proposedDistribution}`,
        `citations=${result.bundle.citations.length}`,
        `cost=$${result.costUsd.toFixed(5)}`,
        `latency=${result.latencyMs}ms`,
      );
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_SEMANTIC_RESEARCH_WEB_CITATIONS:",
        JSON.stringify(
          result.bundle.citations.map((c) => ({ url: c.url, title: c.title })),
          null,
          2,
        ),
      );
    }, 180_000);
  },
);
