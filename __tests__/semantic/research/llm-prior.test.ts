/**
 * Unit tests for the B1 LLM-prior research mechanism.
 *
 * NOTE: The `fetch` substitutes below are TEST-HARNESS FAKES used only to
 * exercise the llm-prior validation rules, prompt-assembly behavior, and
 * error wrapping in isolation. They are NOT product mock data and no
 * product code path consumes them. The production surface still calls
 * the real OpenRouter endpoint through `callChat`; see the gated live
 * integration test for the real-network proof.
 */

import {
  researchLlmPrior,
  LlmPriorResearchError,
} from "@/lib/semantic/research/llm-prior";
import type { ProposedComponent } from "@/lib/semantic/types";

const QUERY = "Will our Q3 product launch hit 10k signups in the first month?";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function chatBody(jsonContent: string, cost = 0.002, model = "test/echo") {
  return {
    model,
    choices: [{ message: { content: jsonContent } }],
    usage: { cost },
  };
}

function makeComponent(
  overrides: Partial<ProposedComponent> = {},
): ProposedComponent {
  return {
    id: overrides.id ?? "waitlist_conversion",
    name: overrides.name ?? "Waitlist conversion rate",
    description:
      overrides.description ??
      "Share of pre-launch waitlist members who actually sign up after launch.",
    suggestedDistribution: overrides.suggestedDistribution ?? "beta",
    why: overrides.why ?? "Bounded in [0,1] and historically variable.",
    dependsOn: overrides.dependsOn,
  };
}

describe("researchLlmPrior", () => {
  test("happy path normal: returns a ResearchBundle with mechanism=llm_prior, preserves componentId and reasoning", async () => {
    const reasoning =
      "B2B SaaS launch volumes typically center around the mid-thousands with substantial spread across companies; a normal centered at 6000 with sd 1800 captures the empirical span.";
    const llmResponse = {
      distribution: "normal",
      params: { mean: 6000, sd: 1800 },
      reasoning,
      citationNames: ["OpenView SaaS Benchmarks (general knowledge)"],
    };
    const component = makeComponent({
      id: "first_month_signups",
      name: "First-month signups",
      suggestedDistribution: "normal",
    });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.004)));

    const result = await researchLlmPrior({
      query: QUERY,
      component,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.componentId).toBe("first_month_signups");
    expect(result.bundle.mechanism).toBe("llm_prior");
    expect(result.bundle.proposedDistribution).toBe("normal");
    expect(result.bundle.proposedParams).toEqual({ mean: 6000, sd: 1800 });
    expect(result.bundle.reasoning).toBe(reasoning);
    expect(result.bundle.citations).toEqual([
      { source: "OpenView SaaS Benchmarks (general knowledge)" },
    ]);
    expect(result.model).toBe("test/echo");
    expect(result.costUsd).toBeCloseTo(0.004, 5);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  test("happy path triangular: params carry min/mode/max in order", async () => {
    const llmResponse = {
      distribution: "triangular",
      params: { min: 1.0, mode: 2.0, max: 5.0 },
      reasoning:
        "No press coverage gives no lift (min=1.0). Most comparable launches see a 2x lift. Best case with editorial pickup tops out near 5x.",
      citationNames: [],
    };
    const component = makeComponent({
      id: "launch_traffic_lift",
      name: "Launch traffic lift",
      suggestedDistribution: "triangular",
    });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.002)));

    const result = await researchLlmPrior({
      query: QUERY,
      component,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.proposedDistribution).toBe("triangular");
    expect(result.bundle.proposedParams).toEqual({ min: 1.0, mode: 2.0, max: 5.0 });
    expect(result.bundle.citations).toEqual([]);
  });

  test("happy path beta: alpha and beta both > 0", async () => {
    const llmResponse = {
      distribution: "beta",
      params: { alpha: 6, beta: 12 },
      reasoning:
        "Beta(6, 12) places the mean near 33% with a 90% interval covering roughly 17%-52%, matching the observed spread of B2B SaaS waitlist conversions.",
      citationNames: ["Product Hunt launch retrospectives (general knowledge)"],
    };
    const component = makeComponent({ suggestedDistribution: "beta" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    const result = await researchLlmPrior({
      query: QUERY,
      component,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.proposedDistribution).toBe("beta");
    expect(result.bundle.proposedParams.alpha).toBeGreaterThan(0);
    expect(result.bundle.proposedParams.beta).toBeGreaterThan(0);
    expect(result.bundle.proposedParams).toEqual({ alpha: 6, beta: 12 });
  });

  test("accepts a distribution revision when reasoning references the original family by name", async () => {
    // Component suggested beta, LLM revises to normal and explains why
    // beta is wrong.
    const llmResponse = {
      distribution: "normal",
      params: { mean: 5000, sd: 1500 },
      reasoning:
        "Although a beta distribution would naturally bound this in [0,1], the quantity here is an absolute count rather than a fraction. A normal distribution centered at 5000 with sd 1500 better matches the observed range.",
      citationNames: [],
    };
    const component = makeComponent({
      id: "absolute_signups",
      name: "Absolute signups",
      suggestedDistribution: "beta",
    });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    const result = await researchLlmPrior({
      query: QUERY,
      component,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.proposedDistribution).toBe("normal");
    expect(result.bundle.proposedParams).toEqual({ mean: 5000, sd: 1500 });
  });

  test("rejects a silent distribution revision (no mention of original family) with DISTRIBUTION_MISMATCH", async () => {
    const llmResponse = {
      distribution: "lognormal",
      params: { mean: 8.5, sd: 0.4 },
      reasoning:
        "Lognormal works well here because the quantity is positive and right-skewed in practice.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "beta" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    await expect(
      researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "LlmPriorResearchError",
      code: "DISTRIBUTION_MISMATCH",
    });
  });

  test("missing params field surfaces MISSING_PARAMS", async () => {
    // params object exists but missing the 'sd' key for a normal distribution.
    const llmResponse = {
      distribution: "normal",
      params: { mean: 100 },
      reasoning:
        "Centered around 100 based on the description; no spread information available.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "normal" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("MISSING_PARAMS");
    expect((caught as LlmPriorResearchError).message).toMatch(/normal/);
  });

  test("normal with sd <= 0 surfaces INVALID_PARAMS", async () => {
    const llmResponse = {
      distribution: "normal",
      params: { mean: 100, sd: 0 },
      reasoning:
        "A point estimate of 100 is reasonable; spread is unknown so left at zero.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "normal" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("INVALID_PARAMS");
    expect((caught as LlmPriorResearchError).message).toMatch(/sd/);
  });

  test("triangular with min > mode surfaces INVALID_PARAMS", async () => {
    const llmResponse = {
      distribution: "triangular",
      params: { min: 5, mode: 2, max: 10 },
      reasoning:
        "Most likely outcome is 2, but min/max anchor the range from 5 to 10.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "triangular" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("INVALID_PARAMS");
    expect((caught as LlmPriorResearchError).message).toMatch(/min/);
  });

  test("uniform with min >= max surfaces INVALID_PARAMS", async () => {
    const llmResponse = {
      distribution: "uniform",
      params: { min: 10, max: 10 },
      reasoning:
        "The quantity is fixed at 10 across all relevant scenarios with no spread.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "uniform" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("INVALID_PARAMS");
  });

  test("empty reasoning string surfaces INVALID_RESPONSE", async () => {
    const llmResponse = {
      distribution: "beta",
      params: { alpha: 5, beta: 10 },
      reasoning: "   ",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "beta" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("INVALID_RESPONSE");
    expect((caught as LlmPriorResearchError).message).toMatch(/reasoning/);
  });

  test("non-array citationNames surfaces INVALID_RESPONSE", async () => {
    const llmResponse = {
      distribution: "beta",
      params: { alpha: 5, beta: 10 },
      reasoning:
        "Beta(5, 10) gives a reasonable shape with the bulk of mass below 0.5.",
      citationNames: "Wikipedia",
    };
    const component = makeComponent({ suggestedDistribution: "beta" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("INVALID_RESPONSE");
    expect((caught as LlmPriorResearchError).message).toMatch(/citationNames/);
  });

  test("rejects an unsupported distribution string as INVALID_RESPONSE", async () => {
    const llmResponse = {
      distribution: "bayesian",
      params: { mean: 100, sd: 10 },
      reasoning: "Some made-up reasoning for an unsupported family.",
      citationNames: [],
    };
    const component = makeComponent({ suggestedDistribution: "normal" });
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    await expect(
      researchLlmPrior({
        query: QUERY,
        component,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "LlmPriorResearchError",
      code: "INVALID_RESPONSE",
    });
  });

  test("non-JSON LLM content surfaces INVALID_RESPONSE", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody("this is not json", 0.0005)));

    await expect(
      researchLlmPrior({
        query: QUERY,
        component: makeComponent(),
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "LlmPriorResearchError",
      code: "INVALID_RESPONSE",
    });
  });

  test("wraps OpenRouterCallError (HTTP 401) into OPENROUTER_ERROR", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "unauthorized" }, { status: 401 }),
      );

    let caught: unknown;
    try {
      await researchLlmPrior({
        query: QUERY,
        component: makeComponent(),
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmPriorResearchError);
    expect((caught as LlmPriorResearchError).code).toBe("OPENROUTER_ERROR");
    expect((caught as LlmPriorResearchError).message).toMatch(/HTTP 401/);
  });

  test("rejects empty query before any LLM call", async () => {
    const fetchFake = jest.fn();
    await expect(
      researchLlmPrior({
        query: "  ",
        component: makeComponent(),
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "LlmPriorResearchError",
      code: "INVALID_RESPONSE",
    });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("tolerates markdown-fenced JSON content from the LLM", async () => {
    const inner = {
      distribution: "beta",
      params: { alpha: 4, beta: 8 },
      reasoning:
        "Beta(4, 8) centers near 1/3 with a moderate spread matching the observed range.",
      citationNames: [],
    };
    const fenced = "```json\n" + JSON.stringify(inner) + "\n```";
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(fenced, 0.0005)));

    const result = await researchLlmPrior({
      query: QUERY,
      component: makeComponent({ suggestedDistribution: "beta" }),
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.bundle.proposedDistribution).toBe("beta");
    expect(result.bundle.proposedParams).toEqual({ alpha: 4, beta: 8 });
  });

  test("preserves a non-empty clarifications array in the user message (smoke check)", async () => {
    const llmResponse = {
      distribution: "beta",
      params: { alpha: 6, beta: 12 },
      reasoning: "Beta(6,12) covers the observed conversion-rate range.",
      citationNames: [],
    };
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    await researchLlmPrior({
      query: QUERY,
      component: makeComponent({ suggestedDistribution: "beta" }),
      clarifications: [
        {
          question: { id: "q1", question: "Which segment?" },
          answer: "B2B SaaS for logistics.",
        },
      ],
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(fetchFake).toHaveBeenCalledTimes(1);
    const call = fetchFake.mock.calls[0];
    const init = call[1] as RequestInit;
    const bodyStr = init.body as string;
    expect(bodyStr).toContain("B2B SaaS for logistics");
    expect(bodyStr).toContain("Which segment");
  });

  test("missing params object entirely surfaces MISSING_PARAMS", async () => {
    const llmResponse = {
      distribution: "normal",
      // params omitted
      reasoning: "Some reasoning that does not include params.",
      citationNames: [],
    };
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(chatBody(JSON.stringify(llmResponse), 0.001)));

    await expect(
      researchLlmPrior({
        query: QUERY,
        component: makeComponent({ suggestedDistribution: "normal" }),
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "LlmPriorResearchError",
      code: "MISSING_PARAMS",
    });
  });
});
