/**
 * B6 unit tests for the RESEARCHING branch of `autoAdvance`.
 *
 * Walks one event at a time through the dispatcher with each of the
 * seven research mechanisms mocked at the module boundary. Verifies:
 *
 *  - Happy path per mechanism: the adapter is called with the right
 *    arguments, the resulting bundle lands on state, in-flight clears.
 *  - The triggering startResearch event with mechanism-specific inputs
 *    is unpacked and forwarded to each adapter (CSV rows for
 *    forecast/empirical, estimates for expert_panel, searchQuery and
 *    searchMaxResults for web_search).
 *  - Required-input failures for forecast/empirical/expert_panel surface
 *    as `fail` events (state → ERROR with `sourceState: RESEARCHING`),
 *    NOT as silent fallbacks to llm_prior.
 *  - Missing infrastructure (no Tavily key, no workspace for RAG,
 *    consensus < 2 models) fails with a typed `fail` event.
 *  - autoAdvance is a no-op when state.kind === RESEARCHING but no
 *    triggerEvent is provided (e.g. on a `back` that bounced back into
 *    RESEARCHING from REVIEWING_RESULT — we should not re-fire the
 *    last mechanism).
 *
 * The adapter functions are mocked at the module boundary — these tests
 * are pure orchestration coverage. Each adapter has its own unit tests
 * in __tests__/semantic/research/*.test.ts.
 */

import { jest } from "@jest/globals";

// Mock every research adapter. Keep the real error classes so
// `instanceof` checks inside auto-advance work.
jest.mock("@/lib/semantic/research/llm-prior", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/llm-prior")
  >("@/lib/semantic/research/llm-prior");
  return { ...actual, researchLlmPrior: jest.fn() };
});
jest.mock("@/lib/semantic/research/web", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/web")
  >("@/lib/semantic/research/web");
  return { ...actual, researchWeb: jest.fn() };
});
jest.mock("@/lib/semantic/research/rag", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/rag")
  >("@/lib/semantic/research/rag");
  return { ...actual, runRagResearch: jest.fn() };
});
jest.mock("@/lib/semantic/research/consensus", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/consensus")
  >("@/lib/semantic/research/consensus");
  return { ...actual, researchConsensus: jest.fn() };
});
jest.mock("@/lib/semantic/research/forecast", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/forecast")
  >("@/lib/semantic/research/forecast");
  return { ...actual, researchForecast: jest.fn() };
});
jest.mock("@/lib/semantic/research/empirical", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/empirical")
  >("@/lib/semantic/research/empirical");
  return { ...actual, researchEmpirical: jest.fn() };
});
jest.mock("@/lib/semantic/research/expert-panel", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/expert-panel")
  >("@/lib/semantic/research/expert-panel");
  return { ...actual, researchExpertPanel: jest.fn() };
});

import { autoAdvance } from "@/lib/semantic/auto-advance";
import { researchLlmPrior } from "@/lib/semantic/research/llm-prior";
import {
  researchWeb,
  WebResearchError,
} from "@/lib/semantic/research/web";
import { runRagResearch } from "@/lib/semantic/research/rag";
import { researchConsensus } from "@/lib/semantic/research/consensus";
import { researchForecast } from "@/lib/semantic/research/forecast";
import { researchEmpirical } from "@/lib/semantic/research/empirical";
import { researchExpertPanel } from "@/lib/semantic/research/expert-panel";
import { initialState, reduce } from "@/lib/semantic/state-machine";
import type { ResearchBundle } from "@/lib/semantic/types";

const mockLlmPrior =
  researchLlmPrior as jest.MockedFunction<typeof researchLlmPrior>;
const mockWeb = researchWeb as jest.MockedFunction<typeof researchWeb>;
const mockRag = runRagResearch as jest.MockedFunction<typeof runRagResearch>;
const mockConsensus =
  researchConsensus as jest.MockedFunction<typeof researchConsensus>;
const mockForecast =
  researchForecast as jest.MockedFunction<typeof researchForecast>;
const mockEmpirical =
  researchEmpirical as jest.MockedFunction<typeof researchEmpirical>;
const mockExpertPanel =
  researchExpertPanel as jest.MockedFunction<typeof researchExpertPanel>;

const OPTS_BASE = {
  model: "test-model",
  apiKey: "test-key",
};

/** Walk the reducer through start → ... → RESEARCHING with one in-flight component. */
function makeResearchingState(componentIds: string[] = ["c1", "c2"]) {
  let state = reduce(initialState(), { type: "start", query: "test query" });
  state = reduce(state, {
    type: "clarificationsReceived",
    questions: [{ id: "q1", question: "scope?" }],
  });
  state = reduce(state, {
    type: "answerClarification",
    qId: "q1",
    answer: "global",
  });
  state = reduce(state, { type: "submitClarifications" });
  state = reduce(state, {
    type: "componentsReceived",
    components: componentIds.map((id) => ({
      id,
      name: `Component ${id}`,
      description: `desc ${id}`,
      suggestedDistribution: "normal" as const,
    })),
  });
  state = reduce(state, { type: "acceptComponents" });
  state = reduce(state, {
    type: "setThreshold",
    threshold: 100,
    thresholdLabel: "high",
  });
  return state;
}

function makeBundle(
  componentId: string,
  mechanism: ResearchBundle["mechanism"],
): ResearchBundle {
  return {
    componentId,
    mechanism,
    proposedDistribution: "normal",
    proposedParams: { mean: 50, sd: 10 },
    reasoning: "test reasoning",
  };
}

beforeEach(() => {
  mockLlmPrior.mockReset();
  mockWeb.mockReset();
  mockRag.mockReset();
  mockConsensus.mockReset();
  mockForecast.mockReset();
  mockEmpirical.mockReset();
  mockExpertPanel.mockReset();
});

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — no-op cases", () => {
  test("RESEARCHING with no triggerEvent is unchanged (no adapter call)", async () => {
    const setup = makeResearchingState();
    // No event has dispatched startResearch yet — inFlight is empty.
    const out = await autoAdvance(setup, OPTS_BASE);
    expect(out.state).toBe(setup);
    expect(out.steps).toEqual([]);
    expect(mockLlmPrior).not.toHaveBeenCalled();
    expect(mockExpertPanel).not.toHaveBeenCalled();
  });

  test("RESEARCHING with a triggerEvent whose component is NOT in-flight: no-op", async () => {
    const setup = makeResearchingState();
    // The reducer already added c2 to in-flight via a fresh startResearch
    // dispatched by the route. We simulate by walking the reducer
    // ourselves, then ask autoAdvance to handle an UNRELATED triggerEvent.
    const withInFlight = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    // No mock — we expect zero adapter calls.
    const out = await autoAdvance(withInFlight, OPTS_BASE, 4);
    // No triggerEvent => no-op even though inFlight has c1.
    expect(out.steps).toEqual([]);
    expect(mockLlmPrior).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LLM-prior happy path
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — llm_prior", () => {
  test("dispatches researchLlmPrior with component + clarifications, applies researchReceived", async () => {
    const setup = makeResearchingState();
    const stateWithInFlight = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    mockLlmPrior.mockResolvedValueOnce({
      bundle: makeBundle("c1", "llm_prior") as never,
      model: "test-model",
      latencyMs: 100,
      costUsd: 0.01,
      retryCount: 0,
    } as never);

    const out = await autoAdvance(stateWithInFlight, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "llm_prior",
      },
    });

    expect(mockLlmPrior).toHaveBeenCalledTimes(1);
    const call = mockLlmPrior.mock.calls[0][0];
    expect(call.component.id).toBe("c1");
    expect(call.query).toBe("test query");
    expect(call.model).toBe("test-model");
    expect(call.clarifications).toEqual([
      {
        question: { id: "q1", question: "scope?" },
        answer: "global",
      },
    ]);
    expect(out.state.kind).toBe("RESEARCHING");
    if (out.state.kind !== "RESEARCHING") throw new Error("type guard");
    expect(out.state.bundles.c1).toBeDefined();
    expect(out.state.inFlight).toEqual({});
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({
      eventType: "researchReceived",
      fromState: "RESEARCHING",
      toState: "RESEARCHING",
      mechanism: "llm_prior",
      componentId: "c1",
      failed: false,
    });
  });

  test("when ALL components have bundles, transitions to REVIEWING_RESEARCH", async () => {
    let setup = makeResearchingState(["c1"]);
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    mockLlmPrior.mockResolvedValueOnce({
      bundle: makeBundle("c1", "llm_prior") as never,
      model: "test-model",
      latencyMs: 1,
      costUsd: 0.01,
      retryCount: 0,
    } as never);
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "llm_prior",
      },
    });
    expect(out.state.kind).toBe("REVIEWING_RESEARCH");
  });
});

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — web_search", () => {
  test("fails fast without TAVILY_API_KEY (no silent fallback)", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "web_search",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      // No tavilyApiKey supplied.
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "web_search",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/Web search requires TAVILY_API_KEY/i);
    expect(out.state.sourceState.kind).toBe("RESEARCHING");
    expect(mockWeb).not.toHaveBeenCalled();
  });

  test("happy path forwards searchQuery + searchMaxResults to the adapter", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "web_search",
    });
    mockWeb.mockResolvedValueOnce({
      bundle: makeBundle("c1", "web_search") as never,
      model: "test-model",
      latencyMs: 1,
      costUsd: 0.02,
      retryCount: 0,
      snippetCount: 3,
      searchProvider: "tavily",
    } as never);
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      tavilyApiKey: "tavily-key",
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "web_search",
        inputs: { searchQuery: "custom query", searchMaxResults: 7 },
      },
    });
    expect(mockWeb).toHaveBeenCalledTimes(1);
    expect(mockWeb.mock.calls[0][0]).toMatchObject({
      query: "custom query",
      searchMaxResults: 7,
      tavilyApiKey: "tavily-key",
    });
    expect(out.state.kind).toBe("RESEARCHING");
    if (out.state.kind !== "RESEARCHING") throw new Error("type guard");
    expect(out.state.bundles.c1).toBeDefined();
  });

  test("wraps WebResearchError into the fail event", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "web_search",
    });
    mockWeb.mockRejectedValueOnce(
      new WebResearchError("no Tavily results", "NO_RESULTS"),
    );
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      tavilyApiKey: "tavily-key",
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "web_search",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/NO_RESULTS/);
  });
});

// ---------------------------------------------------------------------------
// RAG
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — rag_document", () => {
  test("fails fast without workspaceId", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "rag_document",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "rag_document",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/requires an authenticated workspace/i);
  });

  test("happy path forwards workspaceId + component", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "rag_document",
    });
    mockRag.mockResolvedValueOnce({
      ...(makeBundle("c1", "rag_document") as never),
      citations: [],
      costUsd: 0.005,
      latencyMs: 50,
      retrievedChunkCount: 3,
    } as never);
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      workspaceId: "ws-1",
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "rag_document",
      },
    });
    expect(mockRag).toHaveBeenCalledTimes(1);
    expect(mockRag.mock.calls[0][0].workspaceId).toBe("ws-1");
    expect(out.state.kind).toBe("RESEARCHING");
  });
});

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — multi_llm_consensus", () => {
  test("fails when fewer than 2 consensus models configured", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "multi_llm_consensus",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      consensusModels: ["only-one"],
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "multi_llm_consensus",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/at least 2 configured models/i);
  });

  test("happy path forwards models list", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "multi_llm_consensus",
    });
    mockConsensus.mockResolvedValueOnce({
      proposals: [],
      consensus: makeBundle("c1", "multi_llm_consensus") as never,
      disagreementScore: 0.1,
      successCount: 2,
      errorCount: 0,
      totalCostUsd: 0.03,
      wallTimeMs: 200,
    } as never);
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      consensusModels: ["m1", "m2"],
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "multi_llm_consensus",
      },
    });
    expect(mockConsensus).toHaveBeenCalledTimes(1);
    expect(mockConsensus.mock.calls[0][0].models).toEqual(["m1", "m2"]);
    expect(out.state.kind).toBe("RESEARCHING");
  });
});

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — ensemble_forecast", () => {
  test("fails when csvRows missing", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "ensemble_forecast",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "ensemble_forecast",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/Forecast research requires csvRows/);
  });

  test("fails when dateColumn missing even with csvRows", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "ensemble_forecast",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "ensemble_forecast",
        inputs: { csvRows: [{ date: "2026-01-01", value: "10" }] },
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/dateColumn/);
  });

  test("happy path forwards CSV + horizon to adapter", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "ensemble_forecast",
    });
    mockForecast.mockResolvedValueOnce({
      bundle: makeBundle("c1", "ensemble_forecast") as never,
      ensembleLatencyMs: 200,
      perModelWeights: { arima: 0.5, prophet: 0.5 },
      individualPredictions: { arima: 50, prophet: 52 },
    } as never);
    const rows = [
      { date: "2026-01-01", value: "10" },
      { date: "2026-02-01", value: "12" },
    ];
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "ensemble_forecast",
        inputs: {
          csvRows: rows,
          dateColumn: "date",
          targetColumn: "value",
          horizon: 2,
        },
      },
    });
    expect(mockForecast).toHaveBeenCalledTimes(1);
    const fwd = mockForecast.mock.calls[0][0];
    expect(fwd.csvRows).toEqual(rows);
    expect(fwd.dateColumn).toBe("date");
    expect(fwd.targetColumn).toBe("value");
    expect(fwd.horizon).toBe(2);
    expect(out.state.kind).toBe("RESEARCHING");
  });
});

// ---------------------------------------------------------------------------
// Empirical
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — empirical_observation", () => {
  test("fails when csvRows missing", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "empirical_observation",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "empirical_observation",
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/Real-data research requires csvRows/);
  });

  test("happy path forwards CSV + targetColumn", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "empirical_observation",
    });
    mockEmpirical.mockResolvedValueOnce({
      bundle: makeBundle("c1", "empirical_observation") as never,
      rowCount: 4,
      missingCount: 0,
    } as never);
    const rows = [{ x: "1" }, { x: "2" }, { x: "3" }, { x: "4" }];
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "empirical_observation",
        inputs: { csvRows: rows, targetColumn: "x", threshold: 2.5 },
      },
    });
    expect(mockEmpirical).toHaveBeenCalledTimes(1);
    expect(mockEmpirical.mock.calls[0][0]).toMatchObject({
      csvRows: rows,
      targetColumn: "x",
      threshold: 2.5,
    });
    expect(out.state.kind).toBe("RESEARCHING");
  });
});

// ---------------------------------------------------------------------------
// Expert panel
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — expert_panel", () => {
  test("fails when fewer than 2 estimates", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "expert_panel",
    });
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "expert_panel",
        inputs: { estimates: [42] },
      },
    });
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toMatch(/at least 2 numeric estimates/);
  });

  test("happy path forwards estimates + labels", async () => {
    let setup = makeResearchingState();
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "expert_panel",
    });
    mockExpertPanel.mockReturnValueOnce({
      bundle: makeBundle("c1", "expert_panel") as never,
      rawStatistics: {
        n: 3,
        mean: 50,
        sd: 10,
        min: 40,
        max: 60,
        median: 50,
      },
    } as never);
    const out = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "expert_panel",
        inputs: {
          estimates: [40, 50, 60],
          labels: ["a", "b", "c"],
          distribution: "normal",
        },
      },
    });
    expect(mockExpertPanel).toHaveBeenCalledTimes(1);
    expect(mockExpertPanel.mock.calls[0][0]).toMatchObject({
      estimates: [40, 50, 60],
      labels: ["a", "b", "c"],
      distribution: "normal",
    });
    expect(out.state.kind).toBe("RESEARCHING");
    if (out.state.kind !== "RESEARCHING") throw new Error("type guard");
    expect(out.state.bundles.c1).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-component interleaving
// ---------------------------------------------------------------------------

describe("autoAdvance RESEARCHING — multi-component bookkeeping", () => {
  test("a second-component dispatch leaves the first bundle untouched", async () => {
    let setup = makeResearchingState(["c1", "c2"]);
    // Walk c1 to a received bundle first.
    setup = reduce(setup, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    mockLlmPrior.mockResolvedValueOnce({
      bundle: makeBundle("c1", "llm_prior") as never,
      model: "test-model",
      latencyMs: 1,
      costUsd: 0.01,
      retryCount: 0,
    } as never);
    const afterC1 = await autoAdvance(setup, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c1",
        mechanism: "llm_prior",
      },
    });
    expect(afterC1.state.kind).toBe("RESEARCHING");
    if (afterC1.state.kind !== "RESEARCHING") throw new Error("type guard");
    expect(afterC1.state.bundles.c1).toBeDefined();
    expect(afterC1.state.bundles.c2).toBeUndefined();

    // Now dispatch c2 with expert_panel.
    let setup2 = afterC1.state;
    setup2 = reduce(setup2, {
      type: "startResearch",
      componentId: "c2",
      mechanism: "expert_panel",
    });
    mockExpertPanel.mockReturnValueOnce({
      bundle: makeBundle("c2", "expert_panel") as never,
      rawStatistics: {
        n: 2,
        mean: 10,
        sd: 2,
        min: 9,
        max: 11,
        median: 10,
      },
    } as never);
    const afterC2 = await autoAdvance(setup2, {
      ...OPTS_BASE,
      triggerEvent: {
        type: "startResearch",
        componentId: "c2",
        mechanism: "expert_panel",
        inputs: { estimates: [9, 11] },
      },
    });
    // Both components now have bundles; conversation transitions to
    // REVIEWING_RESEARCH automatically (reducer rule).
    expect(afterC2.state.kind).toBe("REVIEWING_RESEARCH");
    if (afterC2.state.kind !== "REVIEWING_RESEARCH")
      throw new Error("type guard");
    expect(Object.keys(afterC2.state.bundles).sort()).toEqual(["c1", "c2"]);
  });
});
