import { proposeGraphs } from "@/lib/ai/multi-proposer";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";

// NOTE: All fetch substitutes below are TEST-HARNESS FAKES used only to
// observe multi-proposer behaviour in isolation (concurrency, isolation of
// per-proposer failures, ordering). They are NOT product mock data — no
// product code path consumes them. The production surface still calls the
// real OpenRouter endpoint through `callChat`; see the integration test for
// the real-network proof.

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function graphChoiceBody(graphJson: string, cost = 0.001) {
  return {
    model: "test/echo",
    choices: [{ message: { content: graphJson } }],
    usage: { cost },
  };
}

function asGraphJson(overrides?: { firstNodeId?: string }) {
  const clone = JSON.parse(JSON.stringify(PE_EXAMPLE_GRAPH));
  if (overrides?.firstNodeId) {
    const oldId = clone.nodes[0].id;
    const newId = overrides.firstNodeId;
    clone.nodes[0].id = newId;
    for (const e of clone.edges) {
      if (e.source === oldId) e.source = newId;
      if (e.target === oldId) e.target = newId;
    }
    if (clone.outputNodeId === oldId) clone.outputNodeId = newId;
  }
  return JSON.stringify(clone);
}

describe("multi-proposer proposeGraphs", () => {
  test("returns one ProposalResult per model in input order", async () => {
    let call = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      const id = call++ === 0 ? "first_only_node" : "second_only_node";
      return jsonResponse(graphChoiceBody(asGraphJson({ firstNodeId: id }), 0.001));
    });

    const result = await proposeGraphs({
      query: "Patient with chest pain — assess PE",
      apiKey: "sk-test",
      models: ["model-a/test", "model-b/test"],
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result).toHaveLength(2);
    expect(result[0].model).toBe("model-a/test");
    expect(result[1].model).toBe("model-b/test");
    expect(result[0].graph?.nodes[0].id).toBe("first_only_node");
    expect(result[1].graph?.nodes[0].id).toBe("second_only_node");
    expect(result[0].error).toBeUndefined();
    expect(result[1].error).toBeUndefined();
  });

  test("isolates a failing proposer from succeeding peers", async () => {
    let call = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      const idx = call++;
      if (idx === 0) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      return jsonResponse(graphChoiceBody(asGraphJson(), 0.001));
    });

    const result = await proposeGraphs({
      query: "Patient with chest pain — assess PE",
      apiKey: "sk-test",
      models: ["broken/model", "ok/model"],
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result).toHaveLength(2);
    expect(result[0].error).toMatch(/HTTP_ERROR HTTP 401/);
    expect(result[0].graph).toBeUndefined();
    expect(result[1].graph).toBeDefined();
    expect(result[1].error).toBeUndefined();
  });

  test("turns parse failures into per-proposer error strings", async () => {
    const fetchFake = jest.fn().mockResolvedValue(
      jsonResponse(graphChoiceBody("this is not json at all", 0.0005))
    );

    const result = await proposeGraphs({
      query: "noisy query",
      apiKey: "sk-test",
      models: ["sloppy/model"],
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result).toHaveLength(1);
    expect(result[0].graph).toBeUndefined();
    expect(result[0].error).toMatch(/PARSE_FAILED/);
    expect(result[0].costUsd).toBe(0.0005);
  });

  test("rejects empty apiKey", async () => {
    await expect(
      proposeGraphs({
        query: "q",
        apiKey: "",
        models: ["a/b"],
      })
    ).rejects.toThrow(/apiKey/);
  });

  test("rejects empty query", async () => {
    await expect(
      proposeGraphs({
        query: "  ",
        apiKey: "sk-test",
        models: ["a/b"],
      })
    ).rejects.toThrow(/query/);
  });

  test("rejects when no models can be resolved", async () => {
    const previousModels = process.env.OPENROUTER_MODELS;
    const previousDefault = process.env.OPENROUTER_DEFAULT_MODEL;
    const previousOR = process.env.OPENROUTER_MODEL;
    const previousAI = process.env.AI_MODELS;
    delete process.env.OPENROUTER_MODELS;
    delete process.env.OPENROUTER_DEFAULT_MODEL;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.AI_MODELS;

    try {
      await expect(
        proposeGraphs({
          query: "q",
          apiKey: "sk-test",
          models: [],
        })
      ).rejects.toThrow(/no models/);
    } finally {
      if (previousModels !== undefined) process.env.OPENROUTER_MODELS = previousModels;
      if (previousDefault !== undefined) process.env.OPENROUTER_DEFAULT_MODEL = previousDefault;
      if (previousOR !== undefined) process.env.OPENROUTER_MODEL = previousOR;
      if (previousAI !== undefined) process.env.AI_MODELS = previousAI;
    }
  });

  test("bounds concurrency to the configured limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return jsonResponse(graphChoiceBody(asGraphJson(), 0.0005));
    });

    const result = await proposeGraphs({
      query: "concurrency test",
      apiKey: "sk-test",
      models: ["a/1", "b/2", "c/3", "d/4", "e/5"],
      concurrencyLimit: 2,
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  test("default concurrency falls back to env var when set", async () => {
    const previous = process.env.OPENROUTER_PROPOSER_CONCURRENCY;
    process.env.OPENROUTER_PROPOSER_CONCURRENCY = "1";

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return jsonResponse(graphChoiceBody(asGraphJson(), 0.0005));
    });

    try {
      const result = await proposeGraphs({
        query: "concurrency env test",
        apiKey: "sk-test",
        models: ["a/1", "b/2", "c/3"],
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
      expect(result).toHaveLength(3);
      expect(maxInFlight).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_PROPOSER_CONCURRENCY;
      else process.env.OPENROUTER_PROPOSER_CONCURRENCY = previous;
    }
  });
});
