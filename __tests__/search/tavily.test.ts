/**
 * Unit tests for the Tavily search provider (Phase B2a).
 *
 * NOTE on fetch fakes: every `fetchFake` below is a TEST-HARNESS FAKE
 * used only to observe the Tavily client's behavior in isolation
 * (status mapping, timeout, JSON parse, snippet coercion). These are
 * NOT product mock data — no production code path consumes them. The
 * production surface still calls the real Tavily endpoint via global
 * fetch; the gated live integration test
 * (`__tests__/integration/semantic-research-web.integration.test.ts`)
 * is the real-network proof.
 */

import { tavilyProvider } from "@/lib/search/tavily";
import { SearchError } from "@/lib/search/provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function happyTavilyBody() {
  return {
    query: "B2B SaaS customer acquisition cost",
    response_time: 0.42,
    results: [
      {
        title: "2024 SaaS CAC benchmark report",
        url: "https://example.com/saas-cac-benchmark-2024",
        content:
          "Across 1,200 B2B SaaS companies median CAC was $1,200 with IQR $700-$2,400.",
        score: 0.93,
      },
      {
        title: "Mid-market SaaS economics primer",
        url: "https://example.com/mid-market-saas-economics",
        content: "Mid-market SaaS CAC typically falls between $800 and $3,000.",
        score: 0.81,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tavilyProvider — happy path", () => {
  test("returns snippets with url/title/content/score and stamps provider + latencyMs", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(happyTavilyBody()));

    const result = await tavilyProvider.search(
      {
        query: "B2B SaaS customer acquisition cost",
        maxResults: 5,
        fetchImpl: fetchFake as unknown as typeof fetch,
      },
      "tvly-test-key",
    );

    expect(result.provider).toBe("tavily");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.snippets).toHaveLength(2);
    expect(result.snippets[0]).toMatchObject({
      title: "2024 SaaS CAC benchmark report",
      url: "https://example.com/saas-cac-benchmark-2024",
    });
    expect(result.snippets[0].content).toMatch(/median CAC was \$1,200/);
    expect(result.snippets[0].score).toBe(0.93);

    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchFake.mock.calls[0];
    expect(calledUrl).toBe("https://api.tavily.com/search");
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(String(calledInit.body));
    // Tavily-spec request body
    expect(body.api_key).toBe("tvly-test-key");
    expect(body.query).toBe("B2B SaaS customer acquisition cost");
    expect(body.max_results).toBe(5);
    expect(body.search_depth).toBe("basic");
  });
});

describe("tavilyProvider — auth failure", () => {
  test("HTTP 401 → SearchError code AUTH with httpStatus", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "unauthorized" }, { status: 401 }));

    const promise = tavilyProvider.search(
      {
        query: "anything",
        fetchImpl: fetchFake as unknown as typeof fetch,
      },
      "tvly-bad-key",
    );
    await expect(promise).rejects.toBeInstanceOf(SearchError);
    await expect(promise).rejects.toMatchObject({ code: "AUTH", httpStatus: 401 });
  });

  test("empty apiKey is rejected before any HTTP call", async () => {
    const fetchFake = jest.fn();
    await expect(
      tavilyProvider.search(
        {
          query: "anything",
          fetchImpl: fetchFake as unknown as typeof fetch,
        },
        "   ",
      ),
    ).rejects.toMatchObject({ name: "SearchError", code: "AUTH" });
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe("tavilyProvider — provider error", () => {
  test("HTTP 500 → SearchError code PROVIDER_ERROR", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "internal" }, { status: 500 }));

    const promise = tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "PROVIDER_ERROR",
      httpStatus: 500,
    });
  });

  test("HTTP 503 → SearchError code PROVIDER_ERROR", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "unavailable" }, { status: 503 }));

    const promise = tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "PROVIDER_ERROR",
      httpStatus: 503,
    });
  });

  test("HTTP 429 → SearchError code HTTP_ERROR (not PROVIDER_ERROR, not AUTH)", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "rate_limited" }, { status: 429 }));

    const promise = tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "HTTP_ERROR",
      httpStatus: 429,
    });
  });
});

describe("tavilyProvider — timeout", () => {
  test("slow fetch that respects AbortSignal → SearchError code TIMEOUT", async () => {
    // A fetch that resolves only when its signal aborts (simulating the
    // real fetch's behavior when the controller fires).
    const fetchFake: jest.Mock = jest.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        }
      });
    });

    const promise = tavilyProvider.search(
      {
        query: "slow query",
        timeoutMs: 25,
        fetchImpl: fetchFake as unknown as typeof fetch,
      },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "TIMEOUT",
    });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
});

describe("tavilyProvider — empty results", () => {
  test("results: [] → snippets: [] (orchestrator decides if NO_RESULTS is fatal)", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ query: "obscure", results: [] }));

    const result = await tavilyProvider.search(
      { query: "obscure", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    expect(result.snippets).toEqual([]);
    expect(result.provider).toBe("tavily");
  });

  test("results missing entirely → snippets: []", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ query: "x" }));

    const result = await tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    expect(result.snippets).toEqual([]);
  });
});

describe("tavilyProvider — network failure", () => {
  test("fetch rejects with non-abort error → SearchError code NETWORK", async () => {
    const fetchFake: jest.Mock = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443"));

    const promise = tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "NETWORK",
    });
  });
});

describe("tavilyProvider — coercion edge cases", () => {
  test("drops snippets without a url (cannot cite a missing source)", async () => {
    const body = {
      results: [
        {
          title: "Has url",
          url: "https://example.com/has-url",
          content: "ok",
        },
        // No url field — should be dropped silently.
        { title: "No url", content: "lost" },
        // Url not a string — also dropped.
        { title: "Bad url", url: 42, content: "lost" },
      ],
    };
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));
    const result = await tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0].url).toBe("https://example.com/has-url");
  });

  test("invalid JSON body → SearchError code PROVIDER_ERROR", async () => {
    const fetchFake = jest.fn().mockResolvedValue(
      new Response("not-json-at-all", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const promise = tavilyProvider.search(
      { query: "x", fetchImpl: fetchFake as unknown as typeof fetch },
      "tvly-test-key",
    );
    await expect(promise).rejects.toMatchObject({
      name: "SearchError",
      code: "PROVIDER_ERROR",
    });
  });
});
