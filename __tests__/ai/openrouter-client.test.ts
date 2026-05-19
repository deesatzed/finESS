import {
  callChat,
  OpenRouterCallError,
} from "@/lib/ai/openrouter-client";

// NOTE: The fetch substitutes below are TEST HARNESS FAKES used only to
// observe the wrapper's HTTP behavior in isolation. They are NOT product
// mock data — no production code path consumes them and the wrapper's real
// product surface still calls the live OpenRouter endpoint.

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function happyBody(content: string, cost = 0.001) {
  return {
    model: "test/echo",
    choices: [
      {
        message: { content },
      },
    ],
    usage: { cost },
  };
}

const BASE_OPTS = {
  model: "test/echo",
  apiKey: "sk-test",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("openrouter-client callChat", () => {
  const originalBudgetEnv = process.env.OPENROUTER_PER_CALL_BUDGET_USD;
  const originalTimeoutEnv = process.env.OPENROUTER_TIMEOUT_MS;

  afterEach(() => {
    if (originalBudgetEnv === undefined) delete process.env.OPENROUTER_PER_CALL_BUDGET_USD;
    else process.env.OPENROUTER_PER_CALL_BUDGET_USD = originalBudgetEnv;
    if (originalTimeoutEnv === undefined) delete process.env.OPENROUTER_TIMEOUT_MS;
    else process.env.OPENROUTER_TIMEOUT_MS = originalTimeoutEnv;
  });

  test("happy path returns content, cost, latency, retry=0", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(happyBody("ok-content", 0.002)));
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0.05,
    });
    expect(result.content).toBe("ok-content");
    expect(result.costUsd).toBe(0.002);
    expect(result.retryCount).toBe(0);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  test("HTTP 200 with empty content AND no tool_calls throws EMPTY_RESPONSE", async () => {
    const fetchFake = jest.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "" } }],
        usage: { cost: 0 },
      })
    );
    await expect(
      callChat({
        ...BASE_OPTS,
        fetchImpl: fetchFake as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      name: "OpenRouterCallError",
      code: "EMPTY_RESPONSE",
    });
  });

  test("HTTP 200 with tool_calls but empty content succeeds and returns toolCalls", async () => {
    const toolCalls = [{ id: "1", type: "function", function: { name: "ping", arguments: "{}" } }];
    const fetchFake = jest.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "", tool_calls: toolCalls } }],
        usage: { cost: 0.0001 },
      })
    );
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0.05,
    });
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual(toolCalls);
    expect(result.retryCount).toBe(0);
  });

  test("HTTP 500 once then 200 succeeds with retry=1", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(happyBody("recovered", 0.0005)));
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0.05,
    });
    expect(result.content).toBe("recovered");
    expect(result.retryCount).toBe(1);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  test("HTTP 500 twice throws HTTP_ERROR (single retry only)", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ error: "boom again" }, { status: 502 }));
    await expect(
      callChat({
        ...BASE_OPTS,
        fetchImpl: fetchFake as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      name: "OpenRouterCallError",
      code: "HTTP_ERROR",
      httpStatus: 502,
    });
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  test("HTTP 401 throws HTTP_ERROR with no retry", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "unauthorized" }, { status: 401 }));
    await expect(
      callChat({
        ...BASE_OPTS,
        fetchImpl: fetchFake as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      name: "OpenRouterCallError",
      code: "HTTP_ERROR",
      httpStatus: 401,
    });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  test("timeout: fetch that never resolves before abort throws TIMEOUT", async () => {
    const fetchFake = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      // Honor the AbortSignal supplied by the wrapper so the timer can win.
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (!signal) return; // never resolves
        const onAbort = () => {
          const err = new Error("The operation was aborted.");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });

    // First attempt times out, retry also times out -> still TIMEOUT
    await expect(
      callChat({
        ...BASE_OPTS,
        fetchImpl: fetchFake as unknown as typeof fetch,
        timeoutMs: 25,
      })
    ).rejects.toMatchObject({
      name: "OpenRouterCallError",
      code: "TIMEOUT",
    });
    // both attempts should have been invoked since TIMEOUT is retryable
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  test("cost over budget throws BUDGET_EXCEEDED carrying the actual cost", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(happyBody("ok", 0.5))); // way over $0.05
    let captured: OpenRouterCallError | undefined;
    try {
      await callChat({
        ...BASE_OPTS,
        fetchImpl: fetchFake as unknown as typeof fetch,
        costBudgetUsd: 0.05,
      });
    } catch (error) {
      if (error instanceof OpenRouterCallError) captured = error;
      else throw error;
    }
    expect(captured).toBeDefined();
    expect(captured!.code).toBe("BUDGET_EXCEEDED");
    expect(captured!.costUsd).toBe(0.5);
  });

  test("cost under budget succeeds and reports costUsd", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(happyBody("ok", 0.001)));
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0.05,
    });
    expect(result.costUsd).toBe(0.001);
    expect(result.content).toBe("ok");
  });

  test("budget=0 disables enforcement even for very expensive calls", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(happyBody("expensive but allowed", 9.99)));
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0,
    });
    expect(result.costUsd).toBe(9.99);
    expect(result.content).toBe("expensive but allowed");
  });

  test("network error on first attempt is retried; second success returns retry=1", async () => {
    const fetchFake = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(happyBody("recovered", 0.001)));
    const result = await callChat({
      ...BASE_OPTS,
      fetchImpl: fetchFake as unknown as typeof fetch,
      costBudgetUsd: 0.05,
    });
    expect(result.retryCount).toBe(1);
    expect(result.content).toBe("recovered");
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });
});
