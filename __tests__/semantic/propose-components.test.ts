import {
  proposeComponents,
  ProposeComponentsError,
} from "@/lib/semantic/propose-components";
import type { ClarifyingQuestion } from "@/lib/semantic/types";

// NOTE: The fetch substitutes below are TEST-HARNESS FAKES used only to
// observe propose-components behaviour in isolation (validation rules,
// error wrapping, prompt assembly). They are NOT product mock data — no
// product code path consumes them. The production surface still calls
// the real OpenRouter endpoint through `callChat`; see the gated live
// integration test for the real-network proof.

const QUESTIONS: ClarifyingQuestion[] = [
  { id: "q1", question: "What product segment is this?" },
  { id: "q2", question: "What is your current pre-launch funnel volume?" },
];

const CLARIFICATIONS = [
  { question: QUESTIONS[0], answer: "B2B SaaS for fleet logistics operators." },
  {
    question: QUESTIONS[1],
    answer: "2k visits/month, 400 waitlist signups.",
  },
];

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

interface MakeComponentOverrides {
  id?: string;
  name?: string;
  description?: string;
  suggestedDistribution?: string;
  why?: string;
  dependsOn?: unknown;
}

function makeComponent(i: number, overrides: MakeComponentOverrides = {}) {
  const base = {
    id: overrides.id ?? `comp_${i}`,
    name: overrides.name ?? `Component ${i}`,
    description:
      overrides.description ?? `Description of component ${i} for the model.`,
    suggestedDistribution: overrides.suggestedDistribution ?? "normal",
    why: overrides.why ?? `Why component ${i} matters for the answer.`,
  } as Record<string, unknown>;
  if (overrides.dependsOn !== undefined) {
    base.dependsOn = overrides.dependsOn;
  }
  return base;
}

function makeComponentList(n: number) {
  return Array.from({ length: n }, (_, i) => makeComponent(i));
}

describe("proposeComponents", () => {
  test("happy path: returns 6 valid components with dependsOn validated", async () => {
    const componentsJson = {
      components: [
        makeComponent(0, {
          id: "baseline_traffic",
          suggestedDistribution: "lognormal",
        }),
        makeComponent(1, {
          id: "launch_traffic_lift",
          suggestedDistribution: "triangular",
        }),
        makeComponent(2, {
          id: "waitlist_conversion",
          suggestedDistribution: "beta",
        }),
        makeComponent(3, {
          id: "cold_visitor_conversion",
          suggestedDistribution: "beta",
        }),
        makeComponent(4, {
          id: "competitive_response_p",
          suggestedDistribution: "beta",
        }),
        makeComponent(5, {
          id: "competitive_response_drag",
          suggestedDistribution: "triangular",
          dependsOn: ["competitive_response_p", "cold_visitor_conversion"],
        }),
      ],
    };

    const fetchFake = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(chatBody(JSON.stringify(componentsJson), 0.003)),
      );

    const result = await proposeComponents({
      query: QUERY,
      clarifications: CLARIFICATIONS,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.components).toHaveLength(6);
    expect(result.components[0].id).toBe("baseline_traffic");
    expect(result.components[5].dependsOn).toEqual([
      "competitive_response_p",
      "cold_visitor_conversion",
    ]);
    expect(result.model).toBe("test/echo");
    expect(result.costUsd).toBeCloseTo(0.003, 5);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  test("rejects empty query before any LLM call", async () => {
    const fetchFake = jest.fn();
    await expect(
      proposeComponents({
        query: "   ",
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "EMPTY_QUERY",
    });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("rejects empty clarifications before any LLM call", async () => {
    const fetchFake = jest.fn();
    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: [],
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "EMPTY_CLARIFICATIONS",
    });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  test("rejects when LLM returns fewer than 4 components", async () => {
    const body = chatBody(
      JSON.stringify({ components: makeComponentList(3) }),
      0.001,
    );
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "TOO_FEW_COMPONENTS",
    });
  });

  test("rejects when LLM returns more than 10 components", async () => {
    const body = chatBody(
      JSON.stringify({ components: makeComponentList(11) }),
      0.001,
    );
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "TOO_MANY_COMPONENTS",
    });
  });

  test("rejects suggestedDistribution outside the allowlist and names the component id", async () => {
    const components = makeComponentList(5);
    (components[2] as Record<string, unknown>).id = "bad_one";
    (components[2] as Record<string, unknown>).suggestedDistribution =
      "bayesian";
    const body = chatBody(JSON.stringify({ components }), 0.001);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    let caught: unknown;
    try {
      await proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProposeComponentsError);
    expect((caught as ProposeComponentsError).code).toBe(
      "INVALID_DISTRIBUTION",
    );
    expect((caught as ProposeComponentsError).message).toMatch(/bad_one/);
    expect((caught as ProposeComponentsError).message).toMatch(/bayesian/);
  });

  test("rejects two components sharing the same id", async () => {
    const components = makeComponentList(5);
    (components[3] as Record<string, unknown>).id = (
      components[1] as Record<string, unknown>
    ).id;
    const body = chatBody(JSON.stringify({ components }), 0.001);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "DUPLICATE_COMPONENT_ID",
    });
  });

  test("rejects dependsOn that points at an unknown component id", async () => {
    const components = makeComponentList(5);
    (components[4] as Record<string, unknown>).id = "tail";
    (components[4] as Record<string, unknown>).dependsOn = ["ghost_id"];
    const body = chatBody(JSON.stringify({ components }), 0.001);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    let caught: unknown;
    try {
      await proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProposeComponentsError);
    expect((caught as ProposeComponentsError).code).toBe("UNKNOWN_DEPENDENCY");
    expect((caught as ProposeComponentsError).message).toMatch(/tail/);
    expect((caught as ProposeComponentsError).message).toMatch(/ghost_id/);
  });

  test("rejects malformed (non-JSON) LLM content as INVALID_RESPONSE", async () => {
    const body = chatBody("this is not json at all", 0.001);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "INVALID_RESPONSE",
    });
  });

  test("wraps OpenRouterCallError (HTTP failure) into OPENROUTER_ERROR", async () => {
    // Status 401 is non-retryable and surfaces as OpenRouterCallError fatal.
    const fetchFake = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "unauthorized" }, { status: 401 }),
      );

    let caught: unknown;
    try {
      await proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProposeComponentsError);
    expect((caught as ProposeComponentsError).code).toBe("OPENROUTER_ERROR");
    expect((caught as ProposeComponentsError).message).toMatch(/HTTP 401/);
  });

  test("rejects when components array is missing entirely", async () => {
    const body = chatBody(JSON.stringify({ notComponents: [] }), 0.0005);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(
      proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ProposeComponentsError",
      code: "INVALID_RESPONSE",
    });
  });

  test("rejects a component missing a required field with an index in the message", async () => {
    const components = makeComponentList(5);
    delete (components[2] as Record<string, unknown>).why;
    const body = chatBody(JSON.stringify({ components }), 0.0005);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    let caught: unknown;
    try {
      await proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProposeComponentsError);
    expect((caught as ProposeComponentsError).code).toBe("INVALID_RESPONSE");
    expect((caught as ProposeComponentsError).message).toMatch(/why/);
    expect((caught as ProposeComponentsError).message).toMatch(/comp_2/);
  });

  test("rejects self-referencing dependsOn", async () => {
    const components = makeComponentList(5);
    (components[1] as Record<string, unknown>).id = "self_ref";
    (components[1] as Record<string, unknown>).dependsOn = ["self_ref"];
    const body = chatBody(JSON.stringify({ components }), 0.0005);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    let caught: unknown;
    try {
      await proposeComponents({
        query: QUERY,
        clarifications: CLARIFICATIONS,
        model: "test/echo",
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProposeComponentsError);
    expect((caught as ProposeComponentsError).code).toBe("UNKNOWN_DEPENDENCY");
    expect((caught as ProposeComponentsError).message).toMatch(/self_ref/);
  });

  test("tolerates markdown-fenced JSON content from the LLM", async () => {
    const components = makeComponentList(4);
    const fenced = "```json\n" + JSON.stringify({ components }) + "\n```";
    const body = chatBody(fenced, 0.0005);
    const fetchFake = jest.fn().mockResolvedValue(jsonResponse(body));

    const result = await proposeComponents({
      query: QUERY,
      clarifications: CLARIFICATIONS,
      model: "test/echo",
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.components).toHaveLength(4);
  });
});
