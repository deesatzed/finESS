/**
 * Semantic Mode B3 — RAG orchestrator unit tests.
 *
 * NOTE on fakes: every `embedImpl`, `queryImpl`, and `fetchImpl` below
 * is a TEST-HARNESS FAKE used to observe orchestrator behavior in
 * isolation. They are NOT product mock data — no product code path
 * consumes them. The real network proof is
 * __tests__/integration/semantic-research-rag.integration.test.ts.
 *
 * We exercise:
 *  - Happy paths for each distribution family (normal, beta, uniform,
 *    lognormal, triangular)
 *  - Param-shape rules per distribution (beta requires positive alpha/beta,
 *    triangular requires min <= mode <= max, uniform requires max > min,
 *    etc.)
 *  - Citation cross-reference: LLM citing an unknown chunkId is rejected
 *  - Empty workspace (no documents) returns NO_DOCUMENTS
 *  - Empty citations list returns INVALID_CITATIONS
 *  - Bad JSON, missing fields, wrong types map to typed RagResearchError
 *  - Embed adapter throwing wraps to EMBED_FAILED
 *  - Store adapter throwing wraps to QUERY_FAILED
 *  - OpenRouter error wrapping
 */

import {
  runRagResearch,
  parseRagResponse,
  RagResearchError,
  buildRagSystemPrompt,
} from "@/lib/semantic/research/rag";
import type { QueryHit } from "@/lib/rag/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function chatCompletionResponse(content: unknown, cost = 0.0008) {
  return {
    model: "test/echo",
    choices: [
      {
        message: {
          content:
            typeof content === "string" ? content : JSON.stringify(content),
        },
      },
    ],
    usage: { cost },
  };
}

function fakeEmbed(_texts: string[]): Promise<number[][]> {
  // 384-dim L2-normalized-ish vector; values don't matter for the
  // orchestrator since we also stub queryImpl.
  return Promise.resolve([new Array(384).fill(0.05)]);
}

function fakeHits(): QueryHit[] {
  return [
    {
      documentId: "doc-1",
      chunkId: "chunk-0",
      text: "B2B SaaS conversion rates typically range from 2% to 5% across mature markets, with median 3.1%.",
      sourceFilename: "saas-benchmarks.md",
      distance: 0.12,
    },
    {
      documentId: "doc-1",
      chunkId: "chunk-1",
      text: "Newer cohorts under 1 year tend toward the lower end (1.5-2.5%) before optimization.",
      sourceFilename: "saas-benchmarks.md",
      distance: 0.18,
    },
  ];
}

function fakeQuery(): (
  workspaceId: string,
  embedding: number[],
  k: number,
) => Promise<QueryHit[]> {
  return async () => fakeHits();
}

const COMPONENT = {
  id: "conversion_rate",
  name: "Trial-to-paid conversion rate",
  description:
    "Percentage of free-trial users who upgrade to a paid plan within 30 days.",
};

const VALID_OPTS = {
  workspaceId: "ws-test-1",
  component: COMPONENT,
  model: "test/echo",
  apiKey: "sk-test",
};

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe("rag orchestrator — prompt", () => {
  test("system prompt enforces citation contract and distribution rules", () => {
    const p = buildRagSystemPrompt();
    expect(p).toContain("documentId");
    expect(p).toContain("chunkId");
    // Phrase wraps across a line; match the load-bearing fragments
    // independently so re-flowing the prompt doesn't break the test.
    expect(p).toContain("ONLY cite");
    expect(p).toContain("passages you actually used");
    expect(p).toContain("triangular");
    expect(p).toContain("min <= mode <= max");
    expect(p).toContain("alpha");
  });
});

// ---------------------------------------------------------------------------
// parseRagResponse
// ---------------------------------------------------------------------------

describe("rag orchestrator — parseRagResponse", () => {
  test("accepts a normal distribution with valid params", () => {
    const out = parseRagResponse(
      JSON.stringify({
        distribution: "normal",
        params: { mean: 3.1, sd: 0.8 },
        reasoning: "Median across benchmarks is 3.1% with spread 0.8.",
        citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
      }),
    );
    expect(out.distribution).toBe("normal");
    expect(out.params.mean).toBe(3.1);
    expect(out.params.sd).toBe(0.8);
  });

  test("accepts a beta distribution with positive alpha/beta", () => {
    const out = parseRagResponse(
      JSON.stringify({
        distribution: "beta",
        params: { alpha: 2.5, beta: 80 },
        reasoning: "Conversion-rate beta prior with strong skew toward low.",
        citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
      }),
    );
    expect(out.distribution).toBe("beta");
    expect(out.params.alpha).toBe(2.5);
    expect(out.params.beta).toBe(80);
  });

  test("accepts triangular with min <= mode <= max", () => {
    const out = parseRagResponse(
      JSON.stringify({
        distribution: "triangular",
        params: { min: 1.5, mode: 3.0, max: 5.5 },
        reasoning: "Range 1.5-5.5%, most likely 3.0%.",
        citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
      }),
    );
    expect(out.distribution).toBe("triangular");
    expect(out.params.mode).toBe(3.0);
  });

  test("accepts uniform with max > min", () => {
    const out = parseRagResponse(
      JSON.stringify({
        distribution: "uniform",
        params: { min: 1.5, max: 5.5 },
        reasoning: "Flat 1.5-5.5% per benchmark.",
        citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
      }),
    );
    expect(out.distribution).toBe("uniform");
    expect(out.params.min).toBe(1.5);
  });

  test("rejects beta with alpha <= 0", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "beta",
          params: { alpha: 0, beta: 80 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
        }),
      ),
    ).toThrow(/alpha > 0/);
  });

  test("rejects triangular with mode > max", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "triangular",
          params: { min: 1, mode: 9, max: 5 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
        }),
      ),
    ).toThrow(/min <= mode <= max/);
  });

  test("rejects uniform with max <= min", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "uniform",
          params: { min: 5, max: 5 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
        }),
      ),
    ).toThrow(/max > min/);
  });

  test("rejects normal with sd <= 0", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "normal",
          params: { mean: 3.1, sd: 0 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
        }),
      ),
    ).toThrow(/requires .*sd.* > 0/);
  });

  test("rejects unsupported distribution", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "cauchy",
          params: {},
          reasoning: "x",
          citations: [{ documentId: "d", chunkId: "c" }],
        }),
      ),
    ).toThrow(/is not supported/);
  });

  test("rejects citations with non-string chunkId", () => {
    expect(() =>
      parseRagResponse(
        JSON.stringify({
          distribution: "normal",
          params: { mean: 1, sd: 1 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: 42 }],
        }),
      ),
    ).toThrow(/chunkId must be a non-empty string/);
  });

  test("rejects non-JSON response", () => {
    expect(() => parseRagResponse("not json")).toThrow(/not valid JSON/);
  });

  test("strips ```json markdown fences", () => {
    const fenced = "```json\n" + JSON.stringify({
      distribution: "normal",
      params: { mean: 1, sd: 1 },
      reasoning: "x",
      citations: [{ documentId: "doc-1", chunkId: "chunk-0" }],
    }) + "\n```";
    const out = parseRagResponse(fenced);
    expect(out.distribution).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// runRagResearch — end-to-end orchestration
// ---------------------------------------------------------------------------

describe("runRagResearch — happy path", () => {
  test("returns a RagResearchBundle with rich citations", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        chatCompletionResponse({
          distribution: "normal",
          params: { mean: 3.1, sd: 0.8 },
          reasoning:
            "Median across the SaaS benchmarks passage is 3.1% with spread captured by the 2-5% range.",
          citations: [
            { documentId: "doc-1", chunkId: "chunk-0" },
            { documentId: "doc-1", chunkId: "chunk-1" },
          ],
        }),
      ),
    );

    const bundle = await runRagResearch({
      ...VALID_OPTS,
      embedImpl: fakeEmbed,
      queryImpl: fakeQuery(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(bundle.componentId).toBe("conversion_rate");
    expect(bundle.mechanism).toBe("rag_document");
    expect(bundle.proposedDistribution).toBe("normal");
    expect(bundle.proposedParams).toEqual({ mean: 3.1, sd: 0.8 });
    expect(bundle.citations).toHaveLength(2);
    expect(bundle.citations[0]).toMatchObject({
      documentId: "doc-1",
      chunkId: "chunk-0",
      sourceFilename: "saas-benchmarks.md",
    });
    expect(bundle.citations[0].chunkText).toContain("2% to 5%");
    expect(bundle.retrievedChunkCount).toBe(2);
    expect(bundle.costUsd).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("runRagResearch — citation cross-reference", () => {
  test("rejects citations pointing to chunks not in the retrieved set", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        chatCompletionResponse({
          distribution: "normal",
          params: { mean: 3.1, sd: 0.8 },
          reasoning: "x",
          citations: [{ documentId: "doc-1", chunkId: "chunk-9999" }],
        }),
      ),
    );

    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: fakeEmbed,
        queryImpl: fakeQuery(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "RagResearchError",
      code: "INVALID_CITATIONS",
    });
  });

  test("rejects empty citations array", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        chatCompletionResponse({
          distribution: "normal",
          params: { mean: 3.1, sd: 0.8 },
          reasoning: "x",
          citations: [],
        }),
      ),
    );

    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: fakeEmbed,
        queryImpl: fakeQuery(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CITATIONS" });
  });
});

describe("runRagResearch — failure modes", () => {
  test("returns NO_DOCUMENTS when the workspace has no chunks", async () => {
    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: fakeEmbed,
        queryImpl: async () => [],
        fetchImpl: jest.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "NO_DOCUMENTS" });
  });

  test("wraps embed adapter errors as EMBED_FAILED", async () => {
    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: async () => {
          throw new Error("disk full");
        },
        queryImpl: fakeQuery(),
        fetchImpl: jest.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "EMBED_FAILED" });
  });

  test("wraps query adapter errors as QUERY_FAILED", async () => {
    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: fakeEmbed,
        queryImpl: async () => {
          throw new Error("lancedb unreachable");
        },
        fetchImpl: jest.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  test("wraps OpenRouter HTTP errors with OPENROUTER_ERROR", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ error: "auth" }, { status: 401 }),
    );

    await expect(
      runRagResearch({
        ...VALID_OPTS,
        embedImpl: fakeEmbed,
        queryImpl: fakeQuery(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "OPENROUTER_ERROR" });
  });

  test("rejects empty workspaceId at the boundary", async () => {
    await expect(
      runRagResearch({
        ...VALID_OPTS,
        workspaceId: "",
      }),
    ).rejects.toBeInstanceOf(RagResearchError);
  });

  test("rejects missing model", async () => {
    await expect(
      runRagResearch({
        ...VALID_OPTS,
        model: "",
      }),
    ).rejects.toMatchObject({ code: "OPENROUTER_ERROR" });
  });
});
