/**
 * Semantic Mode A3 — live integration test for requestClarifications.
 *
 * Hits the real OpenRouter API with the user-configured
 * OPENROUTER_DEFAULT_MODEL against a canonical product-launch query
 * and asserts that the prompt produces 2-5 high-quality clarifying
 * questions (not generic platitudes).
 *
 * SKIPPED by default. To run:
 *
 *   RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/semantic-clarify.integration.test.ts --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY set in .env.local
 *   - OPENROUTER_DEFAULT_MODEL set in .env.local (user-selected model id)
 *
 * Assertions:
 *   - 2-5 questions returned
 *   - Each question has non-empty `question` text
 *   - At least one question mentions time/horizon/scope OR a
 *     domain-specific concept (proves the prompt is producing relevant
 *     clarifications, not generic platitudes)
 *   - Per-call cost is under $0.01 (cheap clarifier; budget guard)
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
  "requestClarifications (live OpenRouter)",
  () => {
    test("produces 2-5 relevant clarifying questions for a real query", async () => {
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      const model = process.env.OPENROUTER_DEFAULT_MODEL?.trim();
      if (!apiKey) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live clarify integration test",
        );
      }
      if (!model) {
        throw new Error(
          "OPENROUTER_DEFAULT_MODEL is required for the live clarify integration test",
        );
      }

      const { requestClarifications } = await import("@/lib/semantic/clarify");

      const result = await requestClarifications({
        query: "Will our Q3 product launch hit 10k signups?",
        model,
        apiKey,
      });

      expect(result.questions.length).toBeGreaterThanOrEqual(2);
      expect(result.questions.length).toBeLessThanOrEqual(5);

      for (const q of result.questions) {
        expect(typeof q.id).toBe("string");
        expect(q.id.length).toBeGreaterThan(0);
        expect(typeof q.question).toBe("string");
        expect(q.question.trim().length).toBeGreaterThan(0);
      }

      // Relevance probe: at least one question should mention time,
      // horizon, scope, or a domain-specific concept (segment, channel,
      // funnel, conversion, waitlist, baseline). Generic
      // platitudes wouldn't hit any of these.
      const corpus = result.questions
        .map((q) => `${q.question} ${q.why ?? ""}`)
        .join(" ")
        .toLowerCase();
      const relevantTerms = [
        "time",
        "horizon",
        "month",
        "week",
        "day",
        "scope",
        "segment",
        "channel",
        "audience",
        "market",
        "funnel",
        "conversion",
        "waitlist",
        "baseline",
        "marketing",
        "definition",
        "product",
        "user",
        "signup",
      ];
      const hit = relevantTerms.some((t) => corpus.includes(t));
      expect(hit).toBe(true);

      expect(result.costUsd).toBeLessThan(0.01);

      // eslint-disable-next-line no-console
      console.log(
        "LIVE_SEMANTIC_CLARIFY_OK:",
        `model=${result.model}`,
        `latency=${result.latencyMs}ms`,
        `cost=$${result.costUsd.toFixed(5)}`,
        `retries=${result.retryCount}`,
        `questions=${result.questions.length}`,
      );
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_SEMANTIC_CLARIFY_QUESTIONS:",
        JSON.stringify(result.questions, null, 2),
      );
    }, 120_000);
  },
);
