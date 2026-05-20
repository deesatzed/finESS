/**
 * B1 — Live integration test for researchLlmPrior.
 *
 * Hits the real OpenRouter API with a single concrete component and
 * proves the live LLM returns a well-formed ResearchBundle whose
 * distribution, params, reasoning, and citations satisfy every contract
 * the unit tests gate.
 *
 * SKIPPED by default. To run:
 *
 *   RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/semantic-research-llm-prior.integration.test.ts --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY set in .env.local
 *   - OPENROUTER_DEFAULT_MODEL (or OPENROUTER_MODEL / OPENROUTER_MODELS)
 *     configured so the test can pick a real model id without hardcoding.
 *     The user always selects model versions.
 *
 * Assertions:
 *   - bundle.componentId matches the input component id.
 *   - bundle.proposedDistribution is in the allowlist.
 *   - bundle.proposedParams shape matches the chosen distribution.
 *   - bundle.reasoning is non-empty and mentions the component name.
 *   - bundle.citations is an array (may be empty).
 *   - Total cost < $0.05.
 */

import path from "node:path";
import dotenv from "dotenv";

const RUN = process.env.RUN_OPENROUTER_LIVE === "1";

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

const VALID_DISTRIBUTIONS = new Set([
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
]);

function assertParamsShape(
  distribution: string,
  params: Record<string, unknown>,
): void {
  const isFinite = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v);
  switch (distribution) {
    case "normal":
    case "lognormal":
      expect(isFinite(params.mean)).toBe(true);
      expect(isFinite(params.sd)).toBe(true);
      expect(params.sd as number).toBeGreaterThan(0);
      break;
    case "beta":
      expect(isFinite(params.alpha)).toBe(true);
      expect(isFinite(params.beta)).toBe(true);
      expect(params.alpha as number).toBeGreaterThan(0);
      expect(params.beta as number).toBeGreaterThan(0);
      break;
    case "uniform":
      expect(isFinite(params.min)).toBe(true);
      expect(isFinite(params.max)).toBe(true);
      expect(params.min as number).toBeLessThan(params.max as number);
      break;
    case "triangular":
      expect(isFinite(params.min)).toBe(true);
      expect(isFinite(params.mode)).toBe(true);
      expect(isFinite(params.max)).toBe(true);
      expect(params.min as number).toBeLessThanOrEqual(params.mode as number);
      expect(params.mode as number).toBeLessThanOrEqual(params.max as number);
      break;
    default:
      throw new Error(`unexpected distribution '${distribution}'`);
  }
}

(RUN ? describe : describe.skip)(
  "researchLlmPrior (live OpenRouter)",
  () => {
    let researchLlmPrior: typeof import("@/lib/semantic/research/llm-prior").researchLlmPrior;
    let getConfiguredModels: typeof import("@/lib/ai/model-config").getConfiguredModels;

    beforeAll(async () => {
      if (!process.env.OPENROUTER_API_KEY?.trim()) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live llm-prior integration test",
        );
      }
      ({ researchLlmPrior } = await import(
        "@/lib/semantic/research/llm-prior"
      ));
      ({ getConfiguredModels } = await import("@/lib/ai/model-config"));
    }, 30_000);

    it("returns a well-formed ResearchBundle for a concrete component under budget", async () => {
      const { defaultModel } = getConfiguredModels();
      expect(defaultModel).toBeTruthy();

      const component = {
        id: "monthly_growth_rate",
        name: "Monthly Growth Rate",
        description:
          "The fraction of monthly recurring revenue growth, expressed as a decimal between 0 and 1, for an early-stage B2B SaaS company.",
        suggestedDistribution: "beta" as const,
        why: "Bounded in [0,1] and historically variable across SaaS companies.",
      };

      const result = await researchLlmPrior({
        query:
          "What is the realistic distribution of monthly MRR growth for an early-stage B2B SaaS company?",
        component,
        clarifications: [
          {
            question: {
              id: "q1",
              question:
                "Which stage are we describing — pre-seed, seed, Series A?",
            },
            answer: "Seed-stage, post-product-market-fit.",
          },
        ],
        model: defaultModel,
        apiKey: process.env.OPENROUTER_API_KEY!,
      });

      // bundle.componentId matches the input.
      expect(result.bundle.componentId).toBe(component.id);
      expect(result.bundle.mechanism).toBe("llm_prior");

      // distribution is in the allowlist.
      expect(VALID_DISTRIBUTIONS.has(result.bundle.proposedDistribution)).toBe(
        true,
      );

      // params shape matches the distribution.
      assertParamsShape(
        result.bundle.proposedDistribution,
        result.bundle.proposedParams as Record<string, unknown>,
      );

      // reasoning is non-empty and mentions the component name (case-
      // insensitive partial match — the LLM may rephrase "Monthly Growth
      // Rate" as "monthly growth" or "MRR growth").
      expect(typeof result.bundle.reasoning).toBe("string");
      expect(result.bundle.reasoning.length).toBeGreaterThan(20);
      const reasoningLower = result.bundle.reasoning.toLowerCase();
      const mentionsTopic =
        reasoningLower.includes("growth") ||
        reasoningLower.includes("mrr") ||
        reasoningLower.includes("rate");
      expect(mentionsTopic).toBe(true);

      // citations is an array (may be empty).
      expect(Array.isArray(result.bundle.citations)).toBe(true);
      for (const c of result.bundle.citations) {
        expect(typeof c.source).toBe("string");
        expect(c.source.length).toBeGreaterThan(0);
      }

      // Cost under the per-call ceiling.
      expect(result.costUsd).toBeLessThan(0.05);

      // Breadcrumb for the orchestrator to capture.
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_LLM_PRIOR_RESEARCH_OK:",
        `model=${result.model}`,
        `distribution=${result.bundle.proposedDistribution}`,
        `params=${JSON.stringify(result.bundle.proposedParams)}`,
        `citations=${result.bundle.citations.length}`,
        `cost=$${result.costUsd.toFixed(4)}`,
        `latency=${result.latencyMs}ms`,
      );
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_LLM_PRIOR_REASONING:",
        result.bundle.reasoning,
      );
    }, 120_000);
  },
);
