/**
 * R6-02 — Live integration test for POST /api/analyze/multi.
 *
 * Hits the real OpenRouter API across both configured models in parallel and
 * proves that the lane returns two real, semantically distinct proposals
 * (no cached/identical outputs).
 *
 * SKIPPED by default. To run:
 *
 *   RUN_OPENROUTER_LIVE=1 npx jest \
 *     __tests__/integration/analyze-multi.integration.test.ts --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY set in .env.local
 *   - OPENROUTER_MODELS configured with at least two model IDs
 *
 * Assertions check that:
 *   - The HTTP response is 200
 *   - Both proposers returned graphs (no errors)
 *   - At least one node differs between the two graphs (proves we got
 *     independent generations, not a cached duplicate)
 *   - Per-call cost is small (under the per-call budget so test failures
 *     point at config, not surprise billing)
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import dotenv from "dotenv";

const RUN = process.env.RUN_OPENROUTER_LIVE === "1";
const TEST_DATABASE_URL = "file:./analyze-multi-integration.test.db";

// Load .env.local so the live key + model list are visible when invoked
// directly via `npx jest ...` rather than `npm test`.
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
  "POST /api/analyze/multi (live OpenRouter)",
  () => {
    let POST: typeof import("@/app/api/analyze/multi/route").POST;
    let resetRateLimit: typeof import("@/app/api/analyze/multi/test-hooks").resetRateLimit;

    beforeAll(async () => {
      if (!process.env.OPENROUTER_API_KEY?.trim()) {
        throw new Error(
          "OPENROUTER_API_KEY is required for the live multi-proposer integration test"
        );
      }
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.LEGACY_PATH_A_ENABLED = "true";
      const pushed = spawnSync(
        "npx",
        ["prisma", "db", "push", "--skip-generate"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
          encoding: "utf8",
        }
      );
      if (pushed.status !== 0) {
        throw new Error(pushed.stderr || pushed.stdout);
      }
      ({ POST } = await import("@/app/api/analyze/multi/route"));
      ({ resetRateLimit } = await import("@/app/api/analyze/multi/test-hooks"));
      resetRateLimit();
    }, 60_000);

    it("returns two real, distinct proposals from configured models", async () => {
      const request = new NextRequest("http://localhost/api/analyze/multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query:
            "A 52-year-old patient presents with sudden-onset pleuritic chest pain and dyspnea. Build an uncertainty graph for the probability of pulmonary embolism given D-dimer and imaging considerations.",
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        proposals: Array<{
          model: string;
          graph?: {
            nodes: Array<{ id: string; mean: number; sd: number }>;
            edges: Array<{ id: string }>;
            outputNodeId: string;
          };
          error?: string;
          latencyMs: number;
          costUsd: number;
        }>;
        summary: {
          successCount: number;
          errorCount: number;
          totalCostUsd: number;
          wallTimeMs: number;
        };
      };

      // Both configured models should have responded with a graph.
      expect(body.proposals.length).toBeGreaterThanOrEqual(2);
      expect(body.summary.errorCount).toBe(0);
      expect(body.summary.successCount).toBe(body.proposals.length);

      const withGraphs = body.proposals.filter((p) => p.graph !== undefined);
      expect(withGraphs.length).toBe(body.proposals.length);

      for (const proposal of withGraphs) {
        expect(proposal.graph!.nodes.length).toBeGreaterThanOrEqual(4);
        expect(proposal.graph!.edges.length).toBeGreaterThan(0);
        expect(proposal.graph!.outputNodeId).toBeTruthy();
      }

      // Independence check: at least one node id (or mean) differs between
      // the two proposers. Identical outputs across distinct models would
      // suggest caching or a degenerate prompt path.
      const first = withGraphs[0].graph!;
      const second = withGraphs[1].graph!;
      const firstNodeIds = first.nodes.map((n) => n.id).sort().join("|");
      const secondNodeIds = second.nodes.map((n) => n.id).sort().join("|");
      const firstMeans = first.nodes.map((n) => n.mean.toFixed(4)).sort().join("|");
      const secondMeans = second.nodes.map((n) => n.mean.toFixed(4)).sort().join("|");
      const distinct =
        firstNodeIds !== secondNodeIds || firstMeans !== secondMeans;
      expect(distinct).toBe(true);

      // Cost discipline: per call should be well under the conservative
      // default per-call budget (0.05). Each proposer is one call.
      for (const proposal of body.proposals) {
        expect(proposal.costUsd).toBeLessThan(0.05);
      }

      // Print a small breadcrumb for the orchestrator to capture.
      // eslint-disable-next-line no-console
      console.log(
        "LIVE_MULTI_PROPOSER_OK:",
        body.proposals
          .map(
            (p) =>
              `${p.model} firstNode=${p.graph?.nodes[0]?.id ?? "ERR"} cost=$${p.costUsd.toFixed(
                4
              )} latency=${p.latencyMs}ms`
          )
          .join(" | "),
        "totalCost=$" + body.summary.totalCostUsd.toFixed(4)
      );
    }, 180_000);
  }
);
