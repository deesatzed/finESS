/**
 * Semantic Mode B4 — live integration test for researchConsensus.
 *
 * Fans out the same per-component research prompt to TWO user-configured
 * OpenRouter models in parallel, validates that each independent
 * proposal is well-formed, and that the synthesized consensus bundle
 * carries `mechanism = "multi_llm_consensus"`.
 *
 * SKIPPED by default. To run:
 *
 *   RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/semantic-research-consensus.integration.test.ts \
 *     --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY set in .env.local
 *   - OPENROUTER_MODELS set in .env.local to a list of >= 2 model ids
 *     (the project default already configures two — google/gemini and
 *     deepseek). The user always selects model versions.
 *
 * Assertions:
 *   - proposals.length === models.length
 *   - successCount >= 1
 *   - If successCount === 2: consensus is non-null and has
 *     mechanism="multi_llm_consensus"
 *   - disagreementScore is in [0, 1]
 *   - Total cost < $0.10 (per-call ceiling at default $0.05 each)
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

(RUN ? describe : describe.skip)(
  "researchConsensus (live OpenRouter)",
  () => {
    test("fans out across configured models and synthesizes consensus", async () => {
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live researchConsensus integration test",
        );
      }

      const { getConfiguredModels } = await import("@/lib/ai/model-config");
      const { researchConsensus } = await import(
        "@/lib/semantic/research/consensus"
      );

      const { models } = getConfiguredModels();
      const modelIds = models.map((m) => m.id).filter((id) => id.length > 0);
      if (modelIds.length < 2) {
        throw new Error(
          `researchConsensus live test needs >= 2 configured models; got ${modelIds.length}`,
        );
      }
      const chosen = modelIds.slice(0, 2);

      const component = {
        id: "monthly_growth_rate",
        name: "Monthly MRR growth rate",
        description:
          "The percentage month-over-month growth in monthly recurring revenue for a mid-stage B2B SaaS.",
        suggestedDistribution: "normal" as const,
        why: "Drives the trajectory of the answer over the forecast horizon.",
      };

      const result = await researchConsensus({
        component,
        query:
          "What monthly MRR growth rate should we plan for over the next 6 months?",
        clarifications: [
          {
            question: {
              id: "q1",
              question: "What is your current ARR?",
            },
            answer: "Approximately $4M ARR.",
          },
          {
            question: {
              id: "q2",
              question: "What segment are you in?",
            },
            answer: "Mid-stage B2B SaaS, fleet logistics niche.",
          },
        ],
        models: chosen,
        apiKey,
      });

      expect(result.proposals.length).toBe(chosen.length);
      expect(result.successCount).toBeGreaterThanOrEqual(1);
      expect(result.successCount + result.errorCount).toBe(chosen.length);

      // Disagreement score always reported and inside the documented range.
      expect(result.disagreementScore).toBeGreaterThanOrEqual(0);
      expect(result.disagreementScore).toBeLessThanOrEqual(1);

      // Consensus present whenever at least one proposer succeeded.
      expect(result.consensus).not.toBeNull();
      expect(result.consensus!.mechanism).toBe("multi_llm_consensus");
      expect(result.consensus!.componentId).toBe(component.id);

      // Total cost guard — two calls at the $0.05 per-call ceiling means
      // an absolute upper bound of $0.10. In practice each clarifier-
      // sized call is well under $0.01.
      expect(result.totalCostUsd).toBeLessThan(0.1);

      // Breadcrumbs for the orchestrator to capture.
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_SEMANTIC_CONSENSUS_OK:",
        `models=[${chosen.join(",")}]`,
        `successCount=${result.successCount}`,
        `errorCount=${result.errorCount}`,
        `disagreementScore=${result.disagreementScore.toFixed(4)}`,
        `consensusDist=${result.consensus!.proposedDistribution}`,
        `totalCost=$${result.totalCostUsd.toFixed(5)}`,
        `wallTime=${result.wallTimeMs}ms`,
      );

      // Per-model first-node snapshot for the agent report.
      for (const p of result.proposals) {
        const summary = p.bundle
          ? `${p.bundle.proposedDistribution} ${JSON.stringify(p.bundle.proposedParams)}`
          : `ERROR=${p.error}`;
        // eslint-disable-next-line no-console
        console.log(
          `LIVE_SEMANTIC_CONSENSUS_PROPOSAL[${p.model}]:`,
          summary,
          `cost=$${p.costUsd.toFixed(5)}`,
          `latency=${p.latencyMs}ms`,
        );
      }
    }, 180_000);
  },
);
