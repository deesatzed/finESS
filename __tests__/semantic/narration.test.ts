/**
 * Semantic Mode A5 — narration mapping unit tests.
 *
 * `narrationFor` is a pure function that maps (prevState, event,
 * nextState) to one plain-language sentence. The contract is:
 *  - Every important transition has a tailored sentence.
 *  - Any unrecognized transition returns a neutral fallback so future
 *    phases adding transitions do not crash the panel.
 *  - No raw user query text or component description is echoed.
 *
 * These tests exercise every documented transition listed in the A5
 * brief plus a few edge cases.
 */
import {
  buildNarrationEntry,
  narrationFor,
} from "@/lib/semantic/narration";
import type {
  SemanticEvent,
  SemanticState,
} from "@/lib/semantic/state-machine";
import type {
  ClarifyingQuestion,
  ModelRunResult,
  ProposedComponent,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QUERY = "How likely is X?";
const QUESTIONS: ClarifyingQuestion[] = [
  { id: "q1", question: "Q1?" },
  { id: "q2", question: "Q2?" },
];
const COMPONENTS: ProposedComponent[] = [
  { id: "c1", name: "First factor", description: "Desc 1" },
  { id: "c2", name: "Second factor", description: "Desc 2" },
];
const RESULT: ModelRunResult = {
  topSensitivityComponentId: "c1",
  pAboveThreshold: 0.42,
};

// ---------------------------------------------------------------------------
// Tests — every documented transition
// ---------------------------------------------------------------------------

describe("narrationFor — primary transitions", () => {
  it("IDLE -> CLARIFYING", () => {
    const line = narrationFor(
      { kind: "IDLE" },
      { type: "start", query: QUERY },
      { kind: "CLARIFYING", query: QUERY },
    );
    expect(line).toMatch(/Thinking about what to ask first/);
    // honest-uncertainty: must not echo query text
    expect(line).not.toMatch(/How likely is X/);
  });

  it("CLARIFYING -> AWAITING_ANSWERS includes the question count", () => {
    const line = narrationFor(
      { kind: "CLARIFYING", query: QUERY },
      { type: "clarificationsReceived", questions: QUESTIONS },
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
    );
    expect(line).toMatch(/2 clarifying questions/);
  });

  it("singularizes 'clarifying question' when count == 1", () => {
    const single: ClarifyingQuestion[] = [{ id: "q1", question: "Q?" }];
    const line = narrationFor(
      { kind: "CLARIFYING", query: QUERY },
      { type: "clarificationsReceived", questions: single },
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: single,
        answers: {},
      },
    );
    expect(line).toMatch(/Asked 1 clarifying question\./);
  });

  it("AWAITING_ANSWERS -> AWAITING_ANSWERS narrates a captured answer softly", () => {
    const line = narrationFor(
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
      { type: "answerClarification", qId: "q1", answer: "yes" },
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: QUESTIONS,
        answers: { q1: "yes" },
      },
    );
    expect(line).toMatch(/Answer captured/);
    expect(line).not.toMatch(/yes/);
  });

  it("AWAITING_ANSWERS -> PROPOSING_COMPONENTS", () => {
    const line = narrationFor(
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
      { type: "submitClarifications" },
      {
        kind: "PROPOSING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
    );
    expect(line).toMatch(/Identifying the key uncertain factors/);
  });

  it("PROPOSING_COMPONENTS -> REVIEWING_COMPONENTS includes component count (plural)", () => {
    const line = narrationFor(
      {
        kind: "PROPOSING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
      { type: "componentsReceived", components: COMPONENTS },
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
    );
    expect(line).toMatch(/Proposed 2 components/);
  });

  it("PROPOSING_COMPONENTS -> REVIEWING_COMPONENTS singularizes for count 1", () => {
    const single: ProposedComponent[] = [
      { id: "only", name: "Only", description: "d" },
    ];
    const line = narrationFor(
      {
        kind: "PROPOSING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
      { type: "componentsReceived", components: single },
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: single,
      },
    );
    expect(line).toMatch(/Proposed 1 component\./);
  });

  it("REVIEWING_COMPONENTS -> REVIEWING_COMPONENTS (editComponent in place)", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
      { type: "editComponent", componentId: "c1", patch: { name: "Renamed" } },
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: [
          { id: "c1", name: "Renamed", description: "Desc 1" },
          COMPONENTS[1],
        ],
      },
    );
    expect(line).toMatch(/Component updated/);
  });

  it("REVIEWING_COMPONENTS -> SETTING_THRESHOLD", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
      { type: "acceptComponents" },
      {
        kind: "SETTING_THRESHOLD",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
    );
    expect(line).toMatch(/What is the decision threshold/);
  });

  it("SETTING_THRESHOLD -> RESEARCHING", () => {
    const line = narrationFor(
      {
        kind: "SETTING_THRESHOLD",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
      { type: "setThreshold", threshold: 0.5, thresholdLabel: "high" },
      {
        kind: "RESEARCHING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        inFlight: {},
      },
    );
    expect(line).toMatch(/researching each component/);
  });

  it("RESEARCHING -> RESEARCHING via startResearch", () => {
    const prev: SemanticState = {
      kind: "RESEARCHING",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high",
      bundles: {},
      inFlight: {},
    };
    const next: SemanticState = {
      ...prev,
      kind: "RESEARCHING",
      inFlight: { c1: "llm_prior" },
    };
    const line = narrationFor(
      prev,
      { type: "startResearch", componentId: "c1", mechanism: "llm_prior" },
      next,
    );
    expect(line).toMatch(/Research started/);
  });

  it("RESEARCHING -> RESEARCHING via researchReceived (more components still pending)", () => {
    const prev: SemanticState = {
      kind: "RESEARCHING",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high",
      bundles: {},
      inFlight: { c1: "llm_prior" },
    };
    const bundle = {
      componentId: "c1",
      mechanism: "llm_prior" as const,
      proposedDistribution: "beta" as const,
      proposedParams: { mean: 0.4, sd: 0.1 },
      reasoning: "r",
    };
    const next: SemanticState = {
      ...prev,
      bundles: { c1: bundle },
      inFlight: {},
    };
    const line = narrationFor(
      prev,
      { type: "researchReceived", componentId: "c1", bundle },
      next,
    );
    expect(line).toMatch(/One component researched/);
  });

  it("RESEARCHING -> REVIEWING_RESEARCH", () => {
    const line = narrationFor(
      {
        kind: "RESEARCHING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        inFlight: { c1: "llm_prior" },
      },
      {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          componentId: "c1",
          mechanism: "llm_prior",
          proposedDistribution: "beta",
          proposedParams: { mean: 0.4, sd: 0.1 },
          reasoning: "r",
        },
      },
      {
        kind: "REVIEWING_RESEARCH",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        accepted: {},
      },
    );
    expect(line).toMatch(/All components researched/);
  });

  it("REVIEWING_RESEARCH -> REVIEWING_RESEARCH (acceptResearch in place)", () => {
    const state: SemanticState = {
      kind: "REVIEWING_RESEARCH",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high",
      bundles: {},
      accepted: {},
    };
    const line = narrationFor(
      state,
      { type: "acceptResearch", componentId: "c1" },
      { ...state, accepted: { c1: true } },
    );
    expect(line).toMatch(/Research bundle accepted/);
  });

  it("REVIEWING_RESEARCH -> MODELING", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_RESEARCH",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        accepted: { c1: true, c2: true },
      },
      { type: "runModel" },
      {
        kind: "MODELING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
      },
    );
    expect(line).toMatch(/Monte Carlo/);
  });

  it("MODELING -> REVIEWING_RESULT names the top component and frames wide intervals as honesty", () => {
    const line = narrationFor(
      {
        kind: "MODELING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
      },
      { type: "modelComplete", result: RESULT },
      {
        kind: "REVIEWING_RESULT",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result: RESULT,
      },
    );
    expect(line).toMatch(/First factor/);
    expect(line).toMatch(/useful honesty/i);
  });

  it("MODELING -> REVIEWING_RESULT falls back to generic copy when top component is unknown", () => {
    const result: ModelRunResult = { pAboveThreshold: 0.3 };
    const line = narrationFor(
      {
        kind: "MODELING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
      },
      { type: "modelComplete", result },
      {
        kind: "REVIEWING_RESULT",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result,
      },
    );
    expect(line).toMatch(/Model complete/);
    expect(line).toMatch(/useful honesty/);
    // No top component to name, but still honest about uncertainty.
    expect(line).not.toMatch(/biggest source/);
  });

  it("MODELING -> REVIEWING_RESULT names topSensitivityComponentId as id when no matching component", () => {
    const result: ModelRunResult = { topSensitivityComponentId: "unknown_id" };
    const line = narrationFor(
      {
        kind: "MODELING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
      },
      { type: "modelComplete", result },
      {
        kind: "REVIEWING_RESULT",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result,
      },
    );
    expect(line).toMatch(/unknown_id/);
  });

  it("REVIEWING_RESULT -> RESEARCHING via verifyNext", () => {
    const prev: SemanticState = {
      kind: "REVIEWING_RESULT",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high",
      bundles: {},
      result: RESULT,
    };
    const line = narrationFor(
      prev,
      { type: "verifyNext", componentId: "c1" },
      {
        kind: "RESEARCHING",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        inFlight: {},
      },
    );
    expect(line).toMatch(/Re-opening research/);
  });

  it("REVIEWING_RESULT -> COMPLETE", () => {
    const prev: SemanticState = {
      kind: "REVIEWING_RESULT",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high",
      bundles: {},
      result: RESULT,
    };
    const line = narrationFor(
      prev,
      { type: "acceptResult" },
      {
        kind: "COMPLETE",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result: RESULT,
      },
    );
    expect(line).toMatch(/Result accepted/);
    expect(line).toMatch(/defensibility/);
  });
});

// ---------------------------------------------------------------------------
// Special events
// ---------------------------------------------------------------------------

describe("narrationFor — special events", () => {
  it("reset returns a neutral 'starting over' line regardless of source state", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_RESULT",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result: RESULT,
      },
      { type: "reset" },
      { kind: "IDLE" },
    );
    expect(line).toMatch(/Starting over/);
  });

  it("fail surfaces the error message and points the user at back", () => {
    const line = narrationFor(
      { kind: "MODELING", query: QUERY, questions: [], answers: {}, components: [], threshold: 0, thresholdLabel: "x", bundles: {} },
      { type: "fail", message: "engine timeout" },
      { kind: "ERROR", message: "engine timeout", sourceState: { kind: "IDLE" } },
    );
    expect(line).toMatch(/engine timeout/);
    expect(line).toMatch(/back/);
  });

  it("fail truncates very long messages", () => {
    const longMessage = "x".repeat(500);
    const line = narrationFor(
      { kind: "MODELING", query: QUERY, questions: [], answers: {}, components: [], threshold: 0, thresholdLabel: "x", bundles: {} },
      { type: "fail", message: longMessage },
      { kind: "ERROR", message: longMessage, sourceState: { kind: "IDLE" } },
    );
    // Should NOT contain all 500 chars (slice(0, 200))
    expect(line.match(/x+/)?.[0].length).toBeLessThanOrEqual(200);
  });

  it("back to AWAITING_ANSWERS preserves the 'answers preserved' messaging", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: { q1: "x" },
        components: COMPONENTS,
      },
      { type: "back" },
      {
        kind: "AWAITING_ANSWERS",
        query: QUERY,
        questions: QUESTIONS,
        answers: { q1: "x" },
      },
    );
    expect(line).toMatch(/answers are preserved/);
  });

  it("back to REVIEWING_RESEARCH mentions accepted bundles are kept", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_RESULT",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        result: RESULT,
      },
      { type: "back" },
      {
        kind: "REVIEWING_RESEARCH",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        accepted: { c1: true, c2: true },
      },
    );
    expect(line).toMatch(/Accepted bundles are preserved/);
  });

  it("back to REVIEWING_COMPONENTS announces edits preserved", () => {
    const line = narrationFor(
      {
        kind: "SETTING_THRESHOLD",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
      { type: "back" },
      {
        kind: "REVIEWING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
    );
    expect(line).toMatch(/Back to the component list/);
  });

  it("back to SETTING_THRESHOLD announces bundles re-confirmation", () => {
    const line = narrationFor(
      {
        kind: "REVIEWING_RESEARCH",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: {},
        accepted: {},
      },
      { type: "back" },
      {
        kind: "SETTING_THRESHOLD",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
        components: COMPONENTS,
      },
    );
    expect(line).toMatch(/Back to setting the decision threshold/);
  });

  it("back to IDLE has a sensible message (from ERROR sourceState=IDLE)", () => {
    const line = narrationFor(
      { kind: "ERROR", message: "x", sourceState: { kind: "IDLE" } },
      { type: "back" },
      { kind: "IDLE" },
    );
    expect(line).toMatch(/Back to the start/);
  });

  it("back to an unmapped destination falls back to a generic 'Back to X' line", () => {
    // Synthesize an unusual back target the switch doesn't list — e.g.
    // CLARIFYING. The reducer wouldn't actually produce this, but we
    // exercise the default branch.
    const line = narrationFor(
      { kind: "ERROR", message: "x", sourceState: { kind: "CLARIFYING", query: QUERY } },
      { type: "back" },
      { kind: "CLARIFYING", query: QUERY },
    );
    expect(line).toMatch(/Back to CLARIFYING/);
  });

  it("unknown transition returns a neutral fallback that mentions from/to kinds", () => {
    // The reducer wouldn't actually allow this; we just exercise the
    // fallback branch.
    const line = narrationFor(
      { kind: "IDLE" },
      { type: "acceptResult" },
      {
        kind: "COMPLETE",
        query: QUERY,
        questions: [],
        answers: {},
        components: [],
        threshold: 0,
        thresholdLabel: "x",
        bundles: {},
        result: RESULT,
      },
    );
    expect(line).toMatch(/Moved from IDLE to COMPLETE/);
  });

  it("a transition into ERROR (not via fail) returns the something-went-wrong line", () => {
    // Synthesize: a hypothetical transition from PROPOSING_COMPONENTS to
    // ERROR via some made-up event type. The function returns the
    // `to === "ERROR"` fallback.
    const line = narrationFor(
      {
        kind: "PROPOSING_COMPONENTS",
        query: QUERY,
        questions: QUESTIONS,
        answers: {},
      },
      // Use a real event type but with an arbitrary state transition;
      // the function only inspects event.type for special cases.
      { type: "componentsReceived", components: [] },
      { kind: "ERROR", message: "x", sourceState: { kind: "IDLE" } },
    );
    expect(line).toMatch(/Something went wrong/);
  });
});

// ---------------------------------------------------------------------------
// buildNarrationEntry
// ---------------------------------------------------------------------------

describe("buildNarrationEntry", () => {
  it("assigns the supplied index, the narration line, and the destination kind", () => {
    const entry = buildNarrationEntry(
      7,
      { kind: "IDLE" },
      { type: "start", query: "Q" },
      { kind: "CLARIFYING", query: "Q" },
    );
    expect(entry.index).toBe(7);
    expect(entry.toStateKind).toBe("CLARIFYING");
    expect(entry.text).toMatch(/Thinking about what to ask first/);
  });

  it("preserves index 0 as a valid first entry", () => {
    const entry = buildNarrationEntry(
      0,
      { kind: "IDLE" },
      { type: "reset" },
      { kind: "IDLE" },
    );
    expect(entry.index).toBe(0);
    expect(entry.toStateKind).toBe("IDLE");
  });
});
