/**
 * Round-trip tests for the Semantic Mode persistence layer (Phase A2).
 *
 * Covers every state kind in `SemanticState`, the recursive ERROR case,
 * and the Set-envelope conversion. Pure unit tests — no Prisma, no
 * HTTP. The API layer is tested separately in __tests__/api/semantic.
 */

import {
  deserializeState,
  serializeState,
  SemanticPersistenceError,
} from "@/lib/semantic/persistence";
import type {
  ClarifyingQuestion,
  ProposedComponent,
  ResearchBundle,
  ModelRunResult,
} from "@/lib/semantic/types";
import type { SemanticState } from "@/lib/semantic/state-machine";

const QUERY = "What is the probability a 55-year-old with chest pain has PE?";

const QUESTIONS: ClarifyingQuestion[] = [
  { id: "q1", question: "Risk factors?", why: "Wells score input", defaultAnswer: "unknown" },
  { id: "q2", question: "D-dimer available?" },
];

const COMPONENTS: ProposedComponent[] = [
  {
    id: "c1",
    name: "Pretest probability",
    description: "Wells score",
    suggestedDistribution: "beta",
  },
  {
    id: "c2",
    name: "D-dimer sensitivity",
    description: "ELISA sensitivity",
    suggestedDistribution: "beta",
    dependsOn: ["c1"],
  },
  { id: "c3", name: "CTPA specificity", description: "CTPA specificity" },
];

function bundleFor(componentId: string): ResearchBundle {
  return {
    componentId,
    mechanism: "llm_prior",
    proposedDistribution: "beta",
    proposedParams: { mean: 0.5, sd: 0.12, alpha: 2, beta: 2 },
    reasoning: `LLM prior for ${componentId}`,
  };
}

const ALL_BUNDLES: Record<string, ResearchBundle> = {
  c1: bundleFor("c1"),
  c2: bundleFor("c2"),
  c3: bundleFor("c3"),
};

const RESULT: ModelRunResult = {
  topSensitivityComponentId: "c2",
  pAboveThreshold: 0.42,
  raw: { samples: 15000, seed: 42 },
};

describe("semantic persistence — round-trip", () => {
  test("IDLE round-trips", () => {
    const state: SemanticState = { kind: "IDLE" };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
  });

  test("CLARIFYING preserves the query verbatim", () => {
    const state: SemanticState = { kind: "CLARIFYING", query: QUERY };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "CLARIFYING") {
      expect(roundTripped.query).toBe(QUERY);
    }
  });

  test("AWAITING_ANSWERS preserves questions and the answers map", () => {
    const state: SemanticState = {
      kind: "AWAITING_ANSWERS",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "thrombophilia", q2: "yes - 700 ng/mL" },
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
  });

  test("PROPOSING_COMPONENTS preserves query, questions, and answers", () => {
    const state: SemanticState = {
      kind: "PROPOSING_COMPONENTS",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "smoker", q2: "no" },
    };
    expect(deserializeState(serializeState(state))).toEqual(state);
  });

  test("REVIEWING_COMPONENTS preserves the components list", () => {
    const state: SemanticState = {
      kind: "REVIEWING_COMPONENTS",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "smoker", q2: "no" },
      components: COMPONENTS,
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "REVIEWING_COMPONENTS") {
      // dependsOn is a load-bearing detail of A4 — must survive intact.
      expect(roundTripped.components[1].dependsOn).toEqual(["c1"]);
    }
  });

  test("SETTING_THRESHOLD round-trips", () => {
    const state: SemanticState = {
      kind: "SETTING_THRESHOLD",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
    };
    expect(deserializeState(serializeState(state))).toEqual(state);
  });

  test("RESEARCHING preserves a non-empty inFlight map of mechanisms", () => {
    const state: SemanticState = {
      kind: "RESEARCHING",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "x", q2: "y" },
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: { c1: bundleFor("c1") },
      inFlight: { c2: "llm_prior", c3: "web_search" },
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "RESEARCHING") {
      expect(Object.keys(roundTripped.inFlight).sort()).toEqual(["c2", "c3"]);
      expect(roundTripped.inFlight.c2).toBe("llm_prior");
      expect(roundTripped.inFlight.c3).toBe("web_search");
    }
  });

  test("RESEARCHING also round-trips an inFlight Set if a future refactor uses Set<string>", () => {
    // Defensive: even if a future change swaps the Record<string,...> for
    // an actual Set, the serializer must round-trip it via the sentinel
    // envelope. This test injects a Set directly to prove that path works.
    const stateWithSet = {
      kind: "RESEARCHING",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: {},
      inFlight: new Set(["c1", "c2", "c3"]),
    } as unknown as SemanticState;
    const json = serializeState(stateWithSet);
    const roundTripped = deserializeState(json) as unknown as {
      kind: string;
      inFlight: Set<string>;
    };
    expect(roundTripped.inFlight).toBeInstanceOf(Set);
    expect(Array.from(roundTripped.inFlight).sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("REVIEWING_RESEARCH preserves the accepted map of bundles", () => {
    const state: SemanticState = {
      kind: "REVIEWING_RESEARCH",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "", q2: "" },
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      accepted: { c1: true, c2: true },
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "REVIEWING_RESEARCH") {
      expect(Object.keys(roundTripped.accepted).sort()).toEqual(["c1", "c2"]);
      expect(roundTripped.accepted.c1).toBe(true);
    }
  });

  test("REVIEWING_RESEARCH also round-trips accepted as a Set<string>", () => {
    const stateWithSet = {
      kind: "REVIEWING_RESEARCH",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      accepted: new Set(["c1", "c2"]),
    } as unknown as SemanticState;
    const roundTripped = deserializeState(
      serializeState(stateWithSet),
    ) as unknown as { kind: string; accepted: Set<string> };
    expect(roundTripped.accepted).toBeInstanceOf(Set);
    expect(Array.from(roundTripped.accepted).sort()).toEqual(["c1", "c2"]);
  });

  test("MODELING round-trips with bundles preserved", () => {
    const state: SemanticState = {
      kind: "MODELING",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "smoker" },
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
    };
    expect(deserializeState(serializeState(state))).toEqual(state);
  });

  test("REVIEWING_RESULT round-trips and preserves result.raw", () => {
    const state: SemanticState = {
      kind: "REVIEWING_RESULT",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      result: RESULT,
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "REVIEWING_RESULT") {
      expect(roundTripped.result.pAboveThreshold).toBe(0.42);
      expect(roundTripped.result.raw).toEqual({ samples: 15000, seed: 42 });
    }
  });

  test("COMPLETE round-trips", () => {
    const state: SemanticState = {
      kind: "COMPLETE",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      result: RESULT,
    };
    expect(deserializeState(serializeState(state))).toEqual(state);
  });

  test("ERROR round-trips its non-trivial sourceState recursively", () => {
    const inner: SemanticState = {
      kind: "REVIEWING_RESEARCH",
      query: QUERY,
      questions: QUESTIONS,
      answers: { q1: "smoker", q2: "yes" },
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      accepted: { c1: true },
    };
    const state: SemanticState = {
      kind: "ERROR",
      message: "transient research provider failure",
      sourceState: inner,
    };
    const roundTripped = deserializeState(serializeState(state));
    expect(roundTripped).toEqual(state);
    if (roundTripped.kind === "ERROR") {
      expect(roundTripped.sourceState.kind).toBe("REVIEWING_RESEARCH");
      if (roundTripped.sourceState.kind === "REVIEWING_RESEARCH") {
        expect(roundTripped.sourceState.accepted.c1).toBe(true);
        expect(roundTripped.sourceState.bundles.c1.componentId).toBe("c1");
      }
    }
  });

  test("ERROR with Set-typed inner state still round-trips faithfully", () => {
    const inner = {
      kind: "REVIEWING_RESEARCH",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: COMPONENTS,
      threshold: 0.5,
      thresholdLabel: "high risk",
      bundles: ALL_BUNDLES,
      accepted: new Set(["c1", "c3"]),
    } as unknown as SemanticState;
    const state: SemanticState = {
      kind: "ERROR",
      message: "boom",
      sourceState: inner,
    };
    const roundTripped = deserializeState(serializeState(state)) as unknown as {
      kind: string;
      sourceState: { kind: string; accepted: Set<string> };
    };
    expect(roundTripped.sourceState.accepted).toBeInstanceOf(Set);
    expect(Array.from(roundTripped.sourceState.accepted).sort()).toEqual([
      "c1",
      "c3",
    ]);
  });

  // -------------------------------------------------------------------------
  // Failure modes
  // -------------------------------------------------------------------------

  test("malformed JSON throws SemanticPersistenceError with a clear message", () => {
    expect(() => deserializeState("not json {")).toThrow(
      SemanticPersistenceError,
    );
    expect(() => deserializeState("not json {")).toThrow(/invalid JSON/);
  });

  test("unknown state kind throws SemanticPersistenceError", () => {
    const json = JSON.stringify({ kind: "BOGUS_STATE", query: QUERY });
    expect(() => deserializeState(json)).toThrow(SemanticPersistenceError);
    expect(() => deserializeState(json)).toThrow(/BOGUS_STATE/);
  });

  test("non-object payload throws", () => {
    expect(() => deserializeState(JSON.stringify(null))).toThrow(
      SemanticPersistenceError,
    );
    expect(() => deserializeState(JSON.stringify("a string"))).toThrow(
      SemanticPersistenceError,
    );
    expect(() => deserializeState(JSON.stringify(42))).toThrow(
      SemanticPersistenceError,
    );
  });

  test("ERROR with invalid inner sourceState is rejected", () => {
    const json = JSON.stringify({
      kind: "ERROR",
      message: "x",
      sourceState: { kind: "NOT_A_REAL_STATE" },
    });
    expect(() => deserializeState(json)).toThrow(SemanticPersistenceError);
  });

  test("serializeState throws on unknown discriminator (defensive)", () => {
    const bogus = { kind: "BOGUS" } as unknown as SemanticState;
    expect(() => serializeState(bogus)).toThrow(SemanticPersistenceError);
  });
});
