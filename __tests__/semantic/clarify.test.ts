/**
 * Semantic Mode A3 — clarify adapter unit tests.
 *
 * NOTE on fetch fakes: every `fetchFake` below is a TEST-HARNESS FAKE
 * used only to observe `requestClarifications` behavior in isolation
 * (shape validation, error mapping, id synthesis, OpenRouter wrapping).
 * These are NOT product mock data — no product code path consumes them.
 * The production surface still calls the real OpenRouter endpoint via
 * `callChat`; the gated live integration test
 * (`__tests__/integration/semantic-clarify.integration.test.ts`) is the
 * real-network proof.
 */

import {
  ClarifyError,
  parseClarifyingResponse,
  requestClarifications,
  buildClarifierSystemPrompt,
} from "@/lib/semantic/clarify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function clarifierChoiceBody(payload: unknown, cost = 0.0005) {
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

function happyPayload() {
  return {
    questions: [
      {
        id: "q1",
        question: "What time horizon are you forecasting over?",
        why: "Short vs long horizon swing the variance dramatically.",
      },
      {
        id: "q2",
        question: "Which geographic scope?",
        why: "Base rates differ by region.",
        defaultAnswer: "US-only",
      },
      {
        id: "q3",
        question: "What decision does this feed into?",
        why: "Threshold depends on the downstream action.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clarify — buildClarifierSystemPrompt", () => {
  test("includes both worked examples and the JSON schema hint", () => {
    const prompt = buildClarifierSystemPrompt();
    // Embedded examples from clarifier-examples.json
    expect(prompt).toContain("Q3 product launch");
    expect(prompt).toContain("pulmonary embolism");
    // Schema hint and bounds
    expect(prompt).toContain('"questions"');
    expect(prompt).toContain("between 2 and 5");
    // Anti-jargon guardrail
    expect(prompt).toContain("non-statistical");
  });
});

describe("clarify — parseClarifyingResponse", () => {
  test("synthesizes stable ids when the LLM omits them", () => {
    const payload = {
      questions: [
        { question: "First?" },
        { question: "Second?" },
      ],
    };
    const out = parseClarifyingResponse(JSON.stringify(payload));
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out[0].question).toBe("First?");
    expect(out[1].question).toBe("Second?");
  });
});

describe("clarify — requestClarifications", () => {
  test("happy path returns 3 questions with latency, cost, retryCount, model", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(clarifierChoiceBody(happyPayload(), 0.0042)));

    const result = await requestClarifications({
      query: "Will our Q3 launch hit 10k signups?",
      model: "user/picked-model",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.questions).toHaveLength(3);
    expect(result.questions[0].question).toMatch(/time horizon/);
    expect(result.questions[1].defaultAnswer).toBe("US-only");
    expect(result.questions.every((q) => q.id && q.id.length > 0)).toBe(true);
    expect(result.costUsd).toBe(0.0042);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.retryCount).toBe(0);
    // callChat surfaces the model from the API response when present;
    // our fake reports "test/echo".
    expect(result.model).toBe("test/echo");
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  test("empty query throws EMPTY_QUERY and makes no LLM call", async () => {
    const fetchFake = jest.fn();
    await expect(
      requestClarifications({
        query: "   ",
        model: "user/picked-model",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "EMPTY_QUERY",
    });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("LLM returns 1 question → TOO_FEW_QUESTIONS", async () => {
    const fetchFake = jest.fn().mockResolvedValue(
      jsonResponse(
        clarifierChoiceBody({
          questions: [{ id: "q1", question: "Only one?" }],
        }),
      ),
    );

    await expect(
      requestClarifications({
        query: "Will it work?",
        model: "user/picked-model",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "TOO_FEW_QUESTIONS",
    });
  });

  test("LLM returns 6 questions → TOO_MANY_QUESTIONS", async () => {
    const tooMany = {
      questions: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i + 1}`,
        question: `Question ${i + 1}?`,
      })),
    };
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(clarifierChoiceBody(tooMany)));

    await expect(
      requestClarifications({
        query: "Will it work?",
        model: "user/picked-model",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "TOO_MANY_QUESTIONS",
    });
  });

  test("LLM returns malformed JSON → INVALID_RESPONSE", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(clarifierChoiceBody("this is not json")));

    await expect(
      requestClarifications({
        query: "Will it work?",
        model: "user/picked-model",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "INVALID_RESPONSE",
    });
  });

  test("LLM returns a question missing the 'question' field → INVALID_RESPONSE naming the bad index", async () => {
    const fetchFake = jest.fn().mockResolvedValue(
      jsonResponse(
        clarifierChoiceBody({
          questions: [
            { id: "q1", question: "Fine" },
            { id: "q2" }, // index 1 missing question
            { id: "q3", question: "Also fine" },
          ],
        }),
      ),
    );

    const promise = requestClarifications({
      query: "Will it work?",
      model: "user/picked-model",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toBeInstanceOf(ClarifyError);
    await expect(promise).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(promise).rejects.toThrow(/index 1/);
  });

  test("LLM returns an object without a 'questions' array → INVALID_RESPONSE", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(clarifierChoiceBody({ foo: "bar" })),
      );

    await expect(
      requestClarifications({
        query: "Will it work?",
        model: "user/picked-model",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "INVALID_RESPONSE",
    });
  });

  test("synthesizes ids end-to-end when LLM omits them", async () => {
    const payload = {
      questions: [
        { question: "First?" },
        { question: "Second?" },
        { question: "Third?" },
      ],
    };
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(clarifierChoiceBody(payload)));

    const result = await requestClarifications({
      query: "any query",
      model: "user/picked-model",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    expect(result.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
  });

  test("wraps OpenRouterCallError (e.g. HTTP 401) into ClarifyError('OPENROUTER_ERROR')", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "unauthorized" }, { status: 401 }));

    const promise = requestClarifications({
      query: "valid query",
      model: "user/picked-model",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    await expect(promise).rejects.toBeInstanceOf(ClarifyError);
    await expect(promise).rejects.toMatchObject({ code: "OPENROUTER_ERROR" });
    await expect(promise).rejects.toThrow(/HTTP 401/);
  });

  test("empty model id is rejected before any LLM call", async () => {
    const fetchFake = jest.fn();
    await expect(
      requestClarifications({
        query: "valid",
        model: "  ",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ClarifyError",
      code: "OPENROUTER_ERROR",
    });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("strips markdown fences around JSON before parsing", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(happyPayload())}\n\`\`\``;
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(clarifierChoiceBody(fenced)));

    const result = await requestClarifications({
      query: "valid query",
      model: "user/picked-model",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });
    expect(result.questions).toHaveLength(3);
  });
});
