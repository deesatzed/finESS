/**
 * Unit tests for the Semantic Mode web-research orchestrator (Phase B2).
 *
 * NOTE on fetch fakes: every `routedFetch` below is a TEST-HARNESS FAKE
 * that dispatches based on the request URL — Tavily requests
 * (`api.tavily.com`) get one response, OpenRouter requests
 * (`openrouter.ai`) get another. These are NOT product mock data — no
 * production code path consumes them. The production surface still
 * calls the real APIs. The gated live integration test
 * (`__tests__/integration/semantic-research-web.integration.test.ts`)
 * is the real-network proof.
 */

import {
  parseExtractorResponse,
  researchWeb,
  WebResearchError,
} from "@/lib/semantic/research/web";
import type { ProposedComponent } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tavilyOk(snippetCount = 2) {
  return {
    query: "B2B SaaS customer acquisition cost distribution range estimate",
    response_time: 0.2,
    results: Array.from({ length: snippetCount }, (_, i) => ({
      title: `Source ${i + 1}`,
      url: `https://example.com/source-${i + 1}`,
      content: `Snippet ${i + 1} content with $${1000 + i * 200} median figure.`,
      score: 0.9 - i * 0.05,
    })),
  };
}

function tavilyEmpty() {
  return { query: "anything", response_time: 0.1, results: [] };
}

function openrouterChoice(payload: unknown, cost = 0.001) {
  return {
    model: "test/echo",
    choices: [
      {
        message: {
          content: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
      },
    ],
    usage: { cost },
  };
}

function happyExtractorPayload() {
  return {
    distribution: "lognormal",
    params: { mean: 1500, sd: 900 },
    reasoning:
      "Both snippets cluster around $1000-$3000 with a right skew typical of acquisition cost distributions.",
    citations: [
      {
        url: "https://example.com/source-1",
        title: "Source 1",
        snippet: "$1000 median figure",
      },
      {
        url: "https://example.com/source-2",
        title: "Source 2",
        snippet: "$1200 median figure",
      },
    ],
  };
}

function sampleComponent(): ProposedComponent {
  return {
    id: "saas_cac",
    name: "B2B SaaS customer acquisition cost",
    description: "Blended cost in USD to acquire one paying customer.",
    suggestedDistribution: "lognormal",
    why: "Drives unit economics and runway.",
  };
}

/**
 * Build a single fetch fake that responds to BOTH Tavily and
 * OpenRouter requests so researchWeb's two-leg pipeline can run
 * end-to-end inside a unit test.
 */
function routedFetch(
  tavilyBody: unknown,
  openrouterBody: unknown,
  init: { tavilyStatus?: number; openrouterStatus?: number } = {},
): jest.Mock {
  return jest.fn().mockImplementation((url: string) => {
    if (url.includes("api.tavily.com")) {
      return Promise.resolve(jsonResponse(tavilyBody, { status: init.tavilyStatus }));
    }
    if (url.includes("openrouter.ai")) {
      return Promise.resolve(
        jsonResponse(openrouterBody, { status: init.openrouterStatus }),
      );
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
}

// ---------------------------------------------------------------------------
// parseExtractorResponse — focused on the LLM response shape
// ---------------------------------------------------------------------------

describe("parseExtractorResponse", () => {
  test("strips markdown fences before JSON parse", () => {
    const fenced = `\`\`\`json\n${JSON.stringify(happyExtractorPayload())}\n\`\`\``;
    const parsed = parseExtractorResponse(fenced);
    expect(parsed.distribution).toBe("lognormal");
    expect(parsed.params.mean).toBe(1500);
    expect(parsed.citations).toHaveLength(2);
  });

  test("rejects invalid distribution name", () => {
    const bad = { ...happyExtractorPayload(), distribution: "cauchy" };
    expect(() => parseExtractorResponse(JSON.stringify(bad))).toThrow(WebResearchError);
    try {
      parseExtractorResponse(JSON.stringify(bad));
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_RESPONSE");
    }
  });

  test("rejects beta missing alpha", () => {
    const bad = {
      distribution: "beta",
      params: { beta: 5 },
      reasoning: "x",
      citations: [{ url: "https://x.com", snippet: "s" }],
    };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_PARAMS");
    }
  });

  test("rejects normal with sd <= 0", () => {
    const bad = {
      distribution: "normal",
      params: { mean: 10, sd: 0 },
      reasoning: "x",
      citations: [{ url: "https://x.com", snippet: "s" }],
    };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_PARAMS");
    }
  });

  test("rejects uniform with min >= max", () => {
    const bad = {
      distribution: "uniform",
      params: { min: 10, max: 10 },
      reasoning: "x",
      citations: [{ url: "https://x.com", snippet: "s" }],
    };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_PARAMS");
    }
  });

  test("rejects triangular with mode < min", () => {
    const bad = {
      distribution: "triangular",
      params: { min: 5, mode: 2, max: 10 },
      reasoning: "x",
      citations: [{ url: "https://x.com", snippet: "s" }],
    };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_PARAMS");
    }
  });

  test("rejects empty citations array", () => {
    const bad = { ...happyExtractorPayload(), citations: [] };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_RESPONSE");
    }
  });

  test("rejects non-array citations", () => {
    const bad = { ...happyExtractorPayload(), citations: { url: "x" } };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_RESPONSE");
    }
  });

  test("rejects citation entry missing url", () => {
    const bad = {
      ...happyExtractorPayload(),
      citations: [{ snippet: "no url here" }],
    };
    try {
      parseExtractorResponse(JSON.stringify(bad));
      fail("expected throw");
    } catch (e) {
      expect((e as WebResearchError).code).toBe("INVALID_RESPONSE");
    }
  });
});

// ---------------------------------------------------------------------------
// researchWeb — end-to-end orchestrator behavior
// ---------------------------------------------------------------------------

describe("researchWeb — happy path", () => {
  test("returns a WebResearchBundle with mechanism=web_search and citation URLs verbatim from snippets", async () => {
    const fetchFake = routedFetch(tavilyOk(2), openrouterChoice(happyExtractorPayload(), 0.002));

    const result = await researchWeb({
      component: sampleComponent(),
      query: "B2B SaaS customer acquisition cost distribution range estimate",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.mechanism).toBe("web_search");
    expect(result.bundle.componentId).toBe("saas_cac");
    expect(result.bundle.proposedDistribution).toBe("lognormal");
    expect(result.bundle.proposedParams.mean).toBe(1500);
    expect(result.bundle.citations).toHaveLength(2);
    expect(result.bundle.citations[0].url).toBe("https://example.com/source-1");
    expect(result.bundle.citations[0].snippet).toMatch(/median/);
    expect(result.snippetCount).toBe(2);
    expect(result.searchProvider).toBe("tavily");
    expect(result.costUsd).toBe(0.002);
    expect(result.retryCount).toBe(0);
    expect(fetchFake).toHaveBeenCalledTimes(2); // Tavily + OpenRouter
  });
});

describe("researchWeb — search-leg failures", () => {
  test("empty Tavily results → WebResearchError('NO_RESULTS') and no LLM call", async () => {
    const openrouterShouldNotBeCalled = openrouterChoice(happyExtractorPayload());
    const fetchFake = routedFetch(tavilyEmpty(), openrouterShouldNotBeCalled);

    const promise = researchWeb({
      component: sampleComponent(),
      query: "obscure",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    await expect(promise).rejects.toBeInstanceOf(WebResearchError);
    await expect(promise).rejects.toMatchObject({ code: "NO_RESULTS" });
    // Only the Tavily call should have happened.
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(fetchFake.mock.calls[0][0]).toContain("api.tavily.com");
  });

  test("Tavily 401 → SearchError propagates as WebResearchError('SEARCH_ERROR') carrying AUTH", async () => {
    const fetchFake = routedFetch(
      { error: "unauthorized" },
      openrouterChoice(happyExtractorPayload()),
      { tavilyStatus: 401 },
    );

    const promise = researchWeb({
      component: sampleComponent(),
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-bad",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toBeInstanceOf(WebResearchError);
    await expect(promise).rejects.toMatchObject({
      code: "SEARCH_ERROR",
      searchErrorCode: "AUTH",
    });
  });
});

describe("researchWeb — extractor-leg failures", () => {
  test("LLM returns malformed JSON → WebResearchError('INVALID_RESPONSE')", async () => {
    const fetchFake = routedFetch(tavilyOk(), openrouterChoice("this is not json"));

    const promise = researchWeb({
      component: sampleComponent(),
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toMatchObject({
      name: "WebResearchError",
      code: "INVALID_RESPONSE",
    });
  });

  test("LLM returns invalid params (beta missing alpha) → INVALID_PARAMS", async () => {
    const bad = {
      distribution: "beta",
      params: { beta: 5 },
      reasoning: "x",
      citations: [{ url: "https://example.com/x", snippet: "y" }],
    };
    const fetchFake = routedFetch(tavilyOk(), openrouterChoice(bad));

    const promise = researchWeb({
      component: sampleComponent(),
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toMatchObject({
      name: "WebResearchError",
      code: "INVALID_PARAMS",
    });
  });

  test("non-array citations → INVALID_RESPONSE", async () => {
    const bad = {
      distribution: "lognormal",
      params: { mean: 1, sd: 1 },
      reasoning: "x",
      citations: "https://example.com",
    };
    const fetchFake = routedFetch(tavilyOk(), openrouterChoice(bad));

    const promise = researchWeb({
      component: sampleComponent(),
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toMatchObject({
      name: "WebResearchError",
      code: "INVALID_RESPONSE",
    });
  });

  test("OpenRouter 401 → WebResearchError('OPENROUTER_ERROR')", async () => {
    const fetchFake = routedFetch(
      tavilyOk(),
      { error: "unauthorized" },
      { openrouterStatus: 401 },
    );

    const promise = researchWeb({
      component: sampleComponent(),
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-bad",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toMatchObject({
      name: "WebResearchError",
      code: "OPENROUTER_ERROR",
    });
  });
});

describe("researchWeb — bundle invariants", () => {
  test("bundle.componentId is forced to component.id even if LLM hallucinates a different id (the schema we send is distribution/params/reasoning/citations — no id field — but we still hard-bind it on the bundle)", async () => {
    // Note: the extractor schema doesn't include a componentId field, so
    // there is nothing for the LLM to hallucinate; we still verify the
    // bundle's componentId is taken from the input component.
    const fetchFake = routedFetch(tavilyOk(), openrouterChoice(happyExtractorPayload()));
    const result = await researchWeb({
      component: { ...sampleComponent(), id: "unique_caller_id" },
      query: "x",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    expect(result.bundle.componentId).toBe("unique_caller_id");
  });

  test("missing tavilyApiKey is rejected before any HTTP call", async () => {
    const fetchFake = jest.fn();
    await expect(
      researchWeb({
        component: sampleComponent(),
        query: "x",
        model: "user/picked-model",
        apiKey: "sk-test",
        tavilyApiKey: "  ",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "WebResearchError", code: "SEARCH_ERROR" });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("missing model id is rejected before any HTTP call", async () => {
    const fetchFake = jest.fn();
    await expect(
      researchWeb({
        component: sampleComponent(),
        query: "x",
        model: "  ",
        apiKey: "sk-test",
        tavilyApiKey: "tvly-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "WebResearchError", code: "OPENROUTER_ERROR" });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("default query is built from component.name when caller passes empty string", async () => {
    const fetchFake = routedFetch(tavilyOk(), openrouterChoice(happyExtractorPayload()));
    await researchWeb({
      component: sampleComponent(),
      query: "",
      model: "user/picked-model",
      apiKey: "sk-test",
      tavilyApiKey: "tvly-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    // First call is to Tavily; inspect its body to confirm the
    // synthesized query contains the component name.
    const [tavilyCall] = fetchFake.mock.calls;
    const body = JSON.parse(String(tavilyCall[1].body));
    expect(body.query).toContain("B2B SaaS customer acquisition cost");
    expect(body.query.toLowerCase()).toContain("distribution");
  });
});
