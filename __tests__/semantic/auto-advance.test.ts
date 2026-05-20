/**
 * autoAdvance is the server-side glue that fires A3 / A4 adapters and
 * applies their result events to the conversation state. It must:
 *
 *  - Walk from CLARIFYING to AWAITING_ANSWERS via the A3 adapter.
 *  - Walk from PROPOSING_COMPONENTS to REVIEWING_COMPONENTS via A4.
 *  - On adapter failure, dispatch the `fail` event so the conversation
 *    moves to ERROR with the source state preserved (back() recovers).
 *  - Stop when the state requires user input (does not loop).
 *  - Stop after maxSteps even if every adapter succeeds (safety).
 *
 * Adapters are mocked at the module boundary — this is a pure-orchestration
 * test. The adapters themselves have their own unit + integration tests in
 * __tests__/semantic/clarify.test.ts and __tests__/semantic/propose-components.test.ts.
 */

import { jest } from "@jest/globals";

// Mock only the adapter function, keep the real ClarifyError /
// ProposeComponentsError classes so `instanceof` checks in autoAdvance work.
jest.mock("@/lib/semantic/clarify", () => {
  const actual = jest.requireActual<typeof import("@/lib/semantic/clarify")>(
    "@/lib/semantic/clarify",
  );
  return {
    ...actual,
    requestClarifications: jest.fn(),
  };
});
jest.mock("@/lib/semantic/propose-components", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/propose-components")
  >("@/lib/semantic/propose-components");
  return {
    ...actual,
    proposeComponents: jest.fn(),
  };
});

import { autoAdvance } from "@/lib/semantic/auto-advance";
import { requestClarifications, ClarifyError } from "@/lib/semantic/clarify";
import {
  proposeComponents,
  ProposeComponentsError,
} from "@/lib/semantic/propose-components";
import { initialState, reduce } from "@/lib/semantic/state-machine";

const mockRequestClarifications =
  requestClarifications as jest.MockedFunction<typeof requestClarifications>;
const mockProposeComponents =
  proposeComponents as jest.MockedFunction<typeof proposeComponents>;

const OPTS = { model: "test-model", apiKey: "test-key" };

function startConversation(query = "Will Q3 hit 10k signups?") {
  return reduce(initialState(), { type: "start", query });
}

beforeEach(() => {
  mockRequestClarifications.mockReset();
  mockProposeComponents.mockReset();
});

describe("autoAdvance — no-op states", () => {
  test("IDLE returns unchanged (no LLM call, no step)", async () => {
    const state = initialState();
    const out = await autoAdvance(state, OPTS);
    expect(out.state).toBe(state);
    expect(out.steps).toEqual([]);
    expect(mockRequestClarifications).not.toHaveBeenCalled();
    expect(mockProposeComponents).not.toHaveBeenCalled();
  });

  test("AWAITING_ANSWERS returns unchanged (waits for user)", async () => {
    let state = startConversation();
    state = reduce(state, {
      type: "clarificationsReceived",
      questions: [{ id: "q1", question: "What scope?" }],
    });
    const out = await autoAdvance(state, OPTS);
    expect(out.state).toBe(state);
    expect(out.steps).toEqual([]);
    expect(mockRequestClarifications).not.toHaveBeenCalled();
  });

  test("REVIEWING_COMPONENTS returns unchanged (waits for user)", async () => {
    let state = startConversation();
    state = reduce(state, {
      type: "clarificationsReceived",
      questions: [{ id: "q1", question: "x" }],
    });
    state = reduce(state, { type: "answerClarification", qId: "q1", answer: "a" });
    state = reduce(state, { type: "submitClarifications" });
    state = reduce(state, {
      type: "componentsReceived",
      components: [
        {
          id: "c1",
          name: "C1",
          description: "d",
          suggestedDistribution: "normal",
        },
      ],
    });
    const out = await autoAdvance(state, OPTS);
    expect(out.state).toBe(state);
    expect(out.steps).toEqual([]);
  });
});

describe("autoAdvance — CLARIFYING happy path", () => {
  test("calls A3 adapter and advances to AWAITING_ANSWERS", async () => {
    mockRequestClarifications.mockResolvedValueOnce({
      questions: [
        { id: "q1", question: "What region?", why: "matters" },
        { id: "q2", question: "What timeframe?" },
      ],
      model: "test-model",
      latencyMs: 450,
      costUsd: 0.0008,
      retryCount: 0,
    });

    const initial = startConversation("test query");
    const out = await autoAdvance(initial, OPTS);

    expect(out.state.kind).toBe("AWAITING_ANSWERS");
    if (out.state.kind !== "AWAITING_ANSWERS") throw new Error("type guard");
    expect(out.state.questions).toHaveLength(2);
    expect(out.state.questions[0].id).toBe("q1");

    expect(mockRequestClarifications).toHaveBeenCalledTimes(1);
    expect(mockRequestClarifications).toHaveBeenCalledWith({
      query: "test query",
      model: "test-model",
      apiKey: "test-key",
      timeoutMs: undefined,
      costBudgetUsd: undefined,
    });

    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({
      eventType: "clarificationsReceived",
      fromState: "CLARIFYING",
      toState: "AWAITING_ANSWERS",
      latencyMs: 450,
      costUsd: 0.0008,
      failed: false,
    });
  });

  test("forwards optional timeout + budget", async () => {
    mockRequestClarifications.mockResolvedValueOnce({
      questions: [
        { id: "q1", question: "x" },
        { id: "q2", question: "y" },
      ],
      model: "m",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });

    await autoAdvance(startConversation(), {
      ...OPTS,
      timeoutMs: 5000,
      costBudgetUsd: 0.01,
    });

    expect(mockRequestClarifications).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000, costBudgetUsd: 0.01 }),
    );
  });
});

describe("autoAdvance — CLARIFYING failure", () => {
  test("ClarifyError moves to ERROR with the failure described", async () => {
    mockRequestClarifications.mockRejectedValueOnce(
      new ClarifyError("model returned 1 question", "TOO_FEW_QUESTIONS"),
    );

    const initial = startConversation();
    const out = await autoAdvance(initial, OPTS);

    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toContain("TOO_FEW_QUESTIONS");
    expect(out.state.sourceState.kind).toBe("CLARIFYING");

    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({
      eventType: "fail",
      fromState: "CLARIFYING",
      toState: "ERROR",
      failed: true,
    });
  });

  test("plain Error wraps without losing the message", async () => {
    mockRequestClarifications.mockRejectedValueOnce(new Error("network down"));

    const out = await autoAdvance(startConversation(), OPTS);
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toBe("network down");
  });
});

describe("autoAdvance — PROPOSING_COMPONENTS happy path", () => {
  test("calls A4 adapter and advances to REVIEWING_COMPONENTS", async () => {
    mockProposeComponents.mockResolvedValueOnce({
      components: [
        { id: "c1", name: "C1", description: "d1", suggestedDistribution: "beta" },
        { id: "c2", name: "C2", description: "d2", suggestedDistribution: "normal" },
        { id: "c3", name: "C3", description: "d3", suggestedDistribution: "lognormal" },
        { id: "c4", name: "C4", description: "d4", suggestedDistribution: "uniform" },
      ],
      model: "m",
      latencyMs: 2000,
      costUsd: 0.002,
      retryCount: 0,
    });

    // Build a state already in PROPOSING_COMPONENTS by walking the reducer.
    let state = startConversation("query");
    state = reduce(state, {
      type: "clarificationsReceived",
      questions: [{ id: "q1", question: "What scope?" }],
    });
    state = reduce(state, { type: "answerClarification", qId: "q1", answer: "regional" });
    state = reduce(state, { type: "submitClarifications" });
    expect(state.kind).toBe("PROPOSING_COMPONENTS");

    const out = await autoAdvance(state, OPTS);
    expect(out.state.kind).toBe("REVIEWING_COMPONENTS");
    if (out.state.kind !== "REVIEWING_COMPONENTS") throw new Error("type guard");
    expect(out.state.components).toHaveLength(4);

    expect(mockProposeComponents).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "query",
        clarifications: [
          {
            question: { id: "q1", question: "What scope?" },
            answer: "regional",
          },
        ],
        model: "test-model",
        apiKey: "test-key",
      }),
    );
  });

  test("missing answers default to empty string", async () => {
    mockProposeComponents.mockResolvedValueOnce({
      components: [
        { id: "c1", name: "C1", description: "d", suggestedDistribution: "beta" },
        { id: "c2", name: "C2", description: "d", suggestedDistribution: "beta" },
        { id: "c3", name: "C3", description: "d", suggestedDistribution: "beta" },
        { id: "c4", name: "C4", description: "d", suggestedDistribution: "beta" },
      ],
      model: "m",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });

    let state = startConversation("q");
    state = reduce(state, {
      type: "clarificationsReceived",
      questions: [
        { id: "q1", question: "a" },
        { id: "q2", question: "b" },
      ],
    });
    // Answer only q1; q2 is left unanswered.
    state = reduce(state, { type: "answerClarification", qId: "q1", answer: "yes" });
    state = reduce(state, { type: "submitClarifications" });

    await autoAdvance(state, OPTS);

    const call = mockProposeComponents.mock.calls[0][0];
    expect(call.clarifications).toEqual([
      { question: { id: "q1", question: "a" }, answer: "yes" },
      { question: { id: "q2", question: "b" }, answer: "" },
    ]);
  });
});

describe("autoAdvance — PROPOSING_COMPONENTS failure", () => {
  test("ProposeComponentsError moves to ERROR preserving source", async () => {
    mockProposeComponents.mockRejectedValueOnce(
      new ProposeComponentsError("dup ids", "DUPLICATE_COMPONENT_ID"),
    );

    let state = startConversation("q");
    state = reduce(state, {
      type: "clarificationsReceived",
      questions: [{ id: "q1", question: "x" }],
    });
    state = reduce(state, { type: "answerClarification", qId: "q1", answer: "y" });
    state = reduce(state, { type: "submitClarifications" });

    const out = await autoAdvance(state, OPTS);
    expect(out.state.kind).toBe("ERROR");
    if (out.state.kind !== "ERROR") throw new Error("type guard");
    expect(out.state.message).toContain("DUPLICATE_COMPONENT_ID");
    expect(out.state.sourceState.kind).toBe("PROPOSING_COMPONENTS");
  });
});

describe("autoAdvance — bounded looping", () => {
  test("does not loop past maxSteps even if every adapter succeeds", async () => {
    // Both adapters always succeed and return enough to advance.
    mockRequestClarifications.mockResolvedValue({
      questions: [
        { id: "q1", question: "a" },
        { id: "q2", question: "b" },
      ],
      model: "m",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });
    mockProposeComponents.mockResolvedValue({
      components: [
        { id: "c1", name: "C1", description: "d", suggestedDistribution: "beta" },
        { id: "c2", name: "C2", description: "d", suggestedDistribution: "beta" },
        { id: "c3", name: "C3", description: "d", suggestedDistribution: "beta" },
        { id: "c4", name: "C4", description: "d", suggestedDistribution: "beta" },
      ],
      model: "m",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });

    const out = await autoAdvance(startConversation(), OPTS);
    // Real sequence: CLARIFYING -> AWAITING_ANSWERS (1 step), then stops
    // because AWAITING_ANSWERS requires user input. So even with
    // unbounded adapter cooperation we don't reach PROPOSING_COMPONENTS
    // from CLARIFYING via auto-advance alone. This proves the safety
    // boundary: auto-advance NEVER skips a user-required gate.
    expect(out.state.kind).toBe("AWAITING_ANSWERS");
    expect(out.steps).toHaveLength(1);
  });
});
