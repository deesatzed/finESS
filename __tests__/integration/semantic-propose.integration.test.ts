/**
 * A4 — Live integration test for proposeComponents.
 *
 * Hits the real OpenRouter API with a known query + minimal clarifications
 * and proves that the live LLM returns a well-formed, allowlist-compliant
 * component list under the per-call cost ceiling.
 *
 * SKIPPED by default. To run:
 *
 *   RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/semantic-propose.integration.test.ts --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY set in .env.local
 *   - OPENROUTER_DEFAULT_MODEL (or OPENROUTER_MODEL / OPENROUTER_MODELS)
 *     configured so the test can pick a real model id without hardcoding.
 *     The user always selects model versions.
 *
 * Assertions:
 *   - 4 to 10 components returned.
 *   - Every component has all required fields.
 *   - Every suggestedDistribution is in the engine's allowlist.
 *   - Total cost under $0.05 (per-call budget guard).
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

(RUN ? describe : describe.skip)(
  "proposeComponents (live OpenRouter)",
  () => {
    let proposeComponents: typeof import("@/lib/semantic/propose-components").proposeComponents;
    let getConfiguredModels: typeof import("@/lib/ai/model-config").getConfiguredModels;

    beforeAll(async () => {
      if (!process.env.OPENROUTER_API_KEY?.trim()) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live propose-components integration test",
        );
      }
      ({ proposeComponents } = await import(
        "@/lib/semantic/propose-components"
      ));
      ({ getConfiguredModels } = await import("@/lib/ai/model-config"));
    }, 30_000);

    it("returns 4-10 allowlist-compliant components under budget", async () => {
      const { defaultModel } = getConfiguredModels();
      expect(defaultModel).toBeTruthy();

      const result = await proposeComponents({
        query:
          "Will our Q3 product launch hit 10k signups in the first month?",
        clarifications: [
          {
            question: {
              id: "q1",
              question:
                "What product segment is this? B2B SaaS, consumer mobile, hardware, or something else?",
            },
            answer: "B2B SaaS for fleet logistics operators.",
          },
          {
            question: {
              id: "q2",
              question:
                "Are you counting signups including waitlist conversions, or only post-launch net-new users?",
            },
            answer: "Tracking only post-launch new signups (not waitlist).",
          },
          {
            question: {
              id: "q3",
              question:
                "What is your current pre-launch funnel volume (website visits, waitlist size, pre-orders)?",
            },
            answer:
              "Current pre-launch funnel: 2k website visits/month, 400 waitlist signups.",
          },
        ],
        model: defaultModel,
        apiKey: process.env.OPENROUTER_API_KEY!,
      });

      expect(result.components.length).toBeGreaterThanOrEqual(4);
      expect(result.components.length).toBeLessThanOrEqual(10);

      const ids = new Set<string>();
      for (const c of result.components) {
        expect(typeof c.id).toBe("string");
        expect(c.id.length).toBeGreaterThan(0);
        expect(ids.has(c.id)).toBe(false);
        ids.add(c.id);

        expect(typeof c.name).toBe("string");
        expect(c.name.length).toBeGreaterThan(0);
        expect(typeof c.description).toBe("string");
        expect(c.description.length).toBeGreaterThan(0);
        expect(typeof c.why).toBe("string");
        expect((c.why as string).length).toBeGreaterThan(0);

        expect(VALID_DISTRIBUTIONS.has(c.suggestedDistribution as string)).toBe(
          true,
        );

        if (c.dependsOn !== undefined) {
          expect(Array.isArray(c.dependsOn)).toBe(true);
          for (const d of c.dependsOn) {
            expect(typeof d).toBe("string");
            expect(d.length).toBeGreaterThan(0);
          }
        }
      }

      // dependsOn cross-check (validator already enforces, but verify
      // the resolved set is internally consistent for the breadcrumb).
      for (const c of result.components) {
        if (!c.dependsOn) continue;
        for (const d of c.dependsOn) {
          expect(ids.has(d)).toBe(true);
        }
      }

      expect(result.costUsd).toBeLessThan(0.05);

      // Breadcrumb for the orchestrator to capture.
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_PROPOSE_COMPONENTS_OK:",
        `model=${result.model}`,
        `count=${result.components.length}`,
        `ids=[${result.components.map((c) => c.id).join(",")}]`,
        `cost=$${result.costUsd.toFixed(4)}`,
        `latency=${result.latencyMs}ms`,
      );
    }, 120_000);
  },
);
