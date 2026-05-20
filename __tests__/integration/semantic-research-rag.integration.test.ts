/**
 * Semantic Mode B3 — live integration test for the RAG orchestrator.
 *
 * End-to-end:
 *   1. Boots a temporary LanceDB root directory.
 *   2. Reads the real markdown fixture (B2B SaaS conversion benchmarks)
 *      from __tests__/fixtures/rag-sample.md. NO synthetic mock — the
 *      fixture is real reference text about a real concept.
 *   3. Chunks + embeds the fixture via the actual BGE pipeline (cold
 *      start downloads ~130 MB the first time; subsequent runs hit the
 *      cache under data/.cache/transformers).
 *   4. Calls runRagResearch against a real component definition and a
 *      real OpenRouter model.
 *   5. Asserts:
 *        - citation count >= 1
 *        - each citation carries documentId + chunkId + chunkText
 *          (and NO `url` field — these are local citations)
 *        - reasoning mentions content from the fixture (conversion /
 *          saas / range / percentile etc.)
 *        - per-call cost is under the default $0.05 ceiling
 *
 * SKIPPED by default. To run:
 *
 *   RUN_RAG_INTEGRATION=1 npx jest \
 *     __tests__/integration/semantic-research-rag.integration.test.ts \
 *     --runInBand
 *
 * Requires:
 *   - OPENROUTER_API_KEY in .env.local
 *   - OPENROUTER_DEFAULT_MODEL in .env.local
 *   - Network access for the first-time BGE model download
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import dotenv from "dotenv";

const RUN = process.env.RUN_RAG_INTEGRATION === "1";

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

(RUN ? describe : describe.skip)("runRagResearch (live BGE + LanceDB + OpenRouter)", () => {
  let tempLanceDir: string;
  const WORKSPACE_ID = "live-rag-workspace";

  beforeAll(async () => {
    tempLanceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finess-rag-live-"));
    process.env.FINESS_LANCEDB_ROOT = tempLanceDir;
  });

  afterAll(async () => {
    if (tempLanceDir) {
      await fs.rm(tempLanceDir, { recursive: true, force: true });
    }
  });

  test("returns a RagResearchBundle with real citations from the fixture", async () => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.OPENROUTER_DEFAULT_MODEL?.trim();
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is required for the live RAG integration test",
      );
    }
    if (!model) {
      throw new Error(
        "OPENROUTER_DEFAULT_MODEL is required for the live RAG integration test",
      );
    }

    // 1) Load the real fixture
    const fixturePath = path.join(
      process.cwd(),
      "__tests__",
      "fixtures",
      "rag-sample.md",
    );
    const fixtureText = await fs.readFile(fixturePath, "utf8");
    expect(fixtureText.length).toBeGreaterThan(100);

    // 2) Chunk + embed via the real adapters
    const { chunkText } = await import("@/lib/rag/chunker");
    const { embed } = await import("@/lib/rag/embed");
    const { addChunks } = await import("@/lib/rag/store");
    const { runRagResearch } = await import("@/lib/semantic/research/rag");

    const chunks = chunkText(fixtureText);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    const vectors = await embed(chunks.map((c) => c.text));
    expect(vectors.length).toBe(chunks.length);
    expect(vectors[0].length).toBe(384);

    const documentId = "doc-live-rag-fixture";
    await addChunks(
      WORKSPACE_ID,
      documentId,
      "rag-sample.md",
      chunks.map((c, i) => ({
        chunkId: c.chunkId,
        text: c.text,
        vector: vectors[i],
      })),
    );

    // 3) Call orchestrator with a real component definition
    const bundle = await runRagResearch({
      workspaceId: WORKSPACE_ID,
      component: {
        id: "trial_to_paid_conversion",
        name: "Trial-to-paid conversion rate",
        description:
          "Percentage of B2B SaaS free-trial users who convert to a paid plan.",
        suggestedDistribution: "beta",
      },
      model,
      apiKey,
    });

    // 4) Assertions
    expect(bundle.componentId).toBe("trial_to_paid_conversion");
    expect(bundle.mechanism).toBe("rag_document");
    expect(["beta", "normal", "triangular", "uniform", "lognormal"]).toContain(
      bundle.proposedDistribution,
    );
    expect(bundle.proposedParams).toBeDefined();

    expect(bundle.citations.length).toBeGreaterThanOrEqual(1);
    for (const c of bundle.citations) {
      expect(typeof c.documentId).toBe("string");
      expect(c.documentId.length).toBeGreaterThan(0);
      expect(typeof c.chunkId).toBe("string");
      expect(c.chunkId.length).toBeGreaterThan(0);
      expect(typeof c.chunkText).toBe("string");
      expect(c.chunkText.length).toBeGreaterThan(0);
      expect(typeof c.sourceFilename).toBe("string");
      expect(c.sourceFilename).toBe("rag-sample.md");
      // Local-only contract: no URL field.
      expect(c).not.toHaveProperty("url");
    }

    const reasoningLower = bundle.reasoning.toLowerCase();
    const fixtureTerms = [
      "conversion",
      "saas",
      "trial",
      "range",
      "percentile",
      "median",
      "skew",
      "plg",
    ];
    const hit = fixtureTerms.some((t) => reasoningLower.includes(t));
    expect(hit).toBe(true);

    expect(bundle.costUsd).toBeLessThan(0.05);

    // eslint-disable-next-line no-console
    console.log(
      "LIVE_SEMANTIC_RAG_OK:",
      `dist=${bundle.proposedDistribution}`,
      `citations=${bundle.citations.length}`,
      `retrieved=${bundle.retrievedChunkCount}`,
      `cost=$${bundle.costUsd.toFixed(5)}`,
      `latency=${bundle.latencyMs}ms`,
    );
    // eslint-disable-next-line no-console
    console.log(
      "LIVE_SEMANTIC_RAG_FIRST_CITATION_EXCERPT:",
      bundle.citations[0].chunkText.slice(0, 200),
    );
  }, 180_000);
});
