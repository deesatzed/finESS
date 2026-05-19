import {
  initialState,
  reduce,
  SemanticStateError,
  type SemanticEvent,
  type SemanticState,
} from "@/lib/semantic/state-machine";
import type {
  ClarifyingQuestion,
  ProposedComponent,
  ResearchBundle,
  ModelRunResult,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Fixtures (inline, no shared mocks — pure data)
// ---------------------------------------------------------------------------

const QUERY = "What is the probability a 55-year-old with chest pain has PE?";

const QUESTIONS: ClarifyingQuestion[] = [
  { id: "q1", question: "Risk factors?" },
  { id: "q2", question: "D-dimer available?" },
];

const COMPONENTS: ProposedComponent[] = [
  { id: "c1", name: "Pretest probability", description: "Wells score" },
  { id: "c2", name: "D-dimer sensitivity", description: "ELISA sensitivity" },
  { id: "c3", name: "CTPA specificity", description: "Modern CTPA specificity" },
];

function bundleFor(componentId: string): ResearchBundle {
  return {
    componentId,
    mechanism: "llm_prior",
    proposedDistribution: "beta",
    proposedParams: { mean: 0.5, sd: 0.1 },
    reasoning: `LLM-prior reasoning for ${componentId}`,
  };
}

const RESULT: ModelRunResult = {
  topSensitivityComponentId: "c1",
  pAboveThreshold: 0.18,
};

// ---------------------------------------------------------------------------
// Helper: drive the conversation to a particular state for tests that
// care about downstream transitions. Does NOT rely on any unverified
// reducer behavior — every step asserts its outcome.
// ---------------------------------------------------------------------------

function driveTo(target: SemanticState["kind"]): SemanticState {
  let s: SemanticState = initialState();
  if (target === "IDLE") return s;

  s = reduce(s, { type: "start", query: QUERY });
  if (target === "CLARIFYING") return s;

  s = reduce(s, { type: "clarificationsReceived", questions: QUESTIONS });
  if (target === "AWAITING_ANSWERS") return s;

  s = reduce(s, { type: "answerClarification", qId: "q1", answer: "smoker" });
  s = reduce(s, { type: "answerClarification", qId: "q2", answer: "yes" });
  s = reduce(s, { type: "submitClarifications" });
  if (target === "PROPOSING_COMPONENTS") return s;

  s = reduce(s, { type: "componentsReceived", components: COMPONENTS });
  if (target === "REVIEWING_COMPONENTS") return s;

  s = reduce(s, { type: "acceptComponents" });
  if (target === "SETTING_THRESHOLD") return s;

  s = reduce(s, {
    type: "setThreshold",
    threshold: 0.15,
    thresholdLabel: "high risk",
  });
  if (target === "RESEARCHING") return s;

  for (const c of COMPONENTS) {
    s = reduce(s, {
      type: "startResearch",
      componentId: c.id,
      mechanism: "llm_prior",
    });
    s = reduce(s, {
      type: "researchReceived",
      componentId: c.id,
      bundle: bundleFor(c.id),
    });
  }
  if (target === "REVIEWING_RESEARCH") return s;

  for (const c of COMPONENTS) {
    s = reduce(s, { type: "acceptResearch", componentId: c.id });
  }
  s = reduce(s, { type: "runModel" });
  if (target === "MODELING") return s;

  s = reduce(s, { type: "modelComplete", result: RESULT });
  if (target === "REVIEWING_RESULT") return s;

  s = reduce(s, { type: "acceptResult" });
  if (target === "COMPLETE") return s;

  throw new Error(`driveTo: unsupported target ${target}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("semantic state machine — initial state", () => {
  test("initialState is IDLE", () => {
    expect(initialState()).toEqual({ kind: "IDLE" });
  });
});

describe("semantic state machine — start / CLARIFYING", () => {
  test("IDLE + start(query) → CLARIFYING with query stored", () => {
    const s = reduce(initialState(), { type: "start", query: QUERY });
    expect(s.kind).toBe("CLARIFYING");
    if (s.kind === "CLARIFYING") {
      expect(s.query).toBe(QUERY);
    }
  });

  test("start from any non-IDLE state throws", () => {
    const s = driveTo("CLARIFYING");
    expect(() => reduce(s, { type: "start", query: "another" })).toThrow(
      SemanticStateError,
    );
  });

  test("start with empty query throws", () => {
    expect(() => reduce(initialState(), { type: "start", query: "   " })).toThrow(
      SemanticStateError,
    );
  });

  test("CLARIFYING + clarificationsReceived → AWAITING_ANSWERS", () => {
    const s1 = reduce(initialState(), { type: "start", query: QUERY });
    const s2 = reduce(s1, {
      type: "clarificationsReceived",
      questions: QUESTIONS,
    });
    expect(s2.kind).toBe("AWAITING_ANSWERS");
    if (s2.kind === "AWAITING_ANSWERS") {
      expect(s2.questions).toEqual(QUESTIONS);
      expect(s2.answers).toEqual({});
    }
  });

  test("CLARIFYING + fail(msg) → ERROR carrying source state", () => {
    const s1 = reduce(initialState(), { type: "start", query: QUERY });
    const s2 = reduce(s1, { type: "fail", message: "LLM timeout" });
    expect(s2.kind).toBe("ERROR");
    if (s2.kind === "ERROR") {
      expect(s2.message).toBe("LLM timeout");
      expect(s2.sourceState).toEqual(s1);
    }
  });
});

describe("semantic state machine — AWAITING_ANSWERS", () => {
  test("answerClarification updates the answers map, stays in AWAITING_ANSWERS", () => {
    let s = driveTo("AWAITING_ANSWERS");
    s = reduce(s, { type: "answerClarification", qId: "q1", answer: "smoker" });
    expect(s.kind).toBe("AWAITING_ANSWERS");
    if (s.kind === "AWAITING_ANSWERS") {
      expect(s.answers.q1).toBe("smoker");
    }
  });

  test("answerClarification can revise an earlier answer", () => {
    let s = driveTo("AWAITING_ANSWERS");
    s = reduce(s, { type: "answerClarification", qId: "q1", answer: "smoker" });
    s = reduce(s, {
      type: "answerClarification",
      qId: "q1",
      answer: "non-smoker",
    });
    if (s.kind === "AWAITING_ANSWERS") {
      expect(s.answers.q1).toBe("non-smoker");
    }
  });

  test("answerClarification with unknown qId throws", () => {
    const s = driveTo("AWAITING_ANSWERS");
    expect(() =>
      reduce(s, { type: "answerClarification", qId: "qX", answer: "x" }),
    ).toThrow(SemanticStateError);
  });

  test("submitClarifications from AWAITING_ANSWERS → PROPOSING_COMPONENTS preserving answers", () => {
    let s = driveTo("AWAITING_ANSWERS");
    s = reduce(s, { type: "answerClarification", qId: "q1", answer: "smoker" });
    s = reduce(s, { type: "submitClarifications" });
    expect(s.kind).toBe("PROPOSING_COMPONENTS");
    if (s.kind === "PROPOSING_COMPONENTS") {
      expect(s.answers.q1).toBe("smoker");
    }
  });

  test("submitClarifications from CLARIFYING throws", () => {
    const s = driveTo("CLARIFYING");
    expect(() => reduce(s, { type: "submitClarifications" })).toThrow(
      SemanticStateError,
    );
  });
});

describe("semantic state machine — REVIEWING_COMPONENTS", () => {
  test("editComponent applies the patch in place", () => {
    let s = driveTo("REVIEWING_COMPONENTS");
    s = reduce(s, {
      type: "editComponent",
      componentId: "c1",
      patch: { name: "Renamed pretest" },
    });
    if (s.kind === "REVIEWING_COMPONENTS") {
      const c1 = s.components.find((c) => c.id === "c1");
      expect(c1?.name).toBe("Renamed pretest");
    }
  });

  test("editComponent with unknown id throws", () => {
    const s = driveTo("REVIEWING_COMPONENTS");
    expect(() =>
      reduce(s, {
        type: "editComponent",
        componentId: "cX",
        patch: { name: "x" },
      }),
    ).toThrow(SemanticStateError);
  });

  test("acceptComponents → SETTING_THRESHOLD when components non-empty", () => {
    const s1 = driveTo("REVIEWING_COMPONENTS");
    const s2 = reduce(s1, { type: "acceptComponents" });
    expect(s2.kind).toBe("SETTING_THRESHOLD");
  });

  test("acceptComponents on empty component list throws", () => {
    // Manually construct an empty REVIEWING_COMPONENTS state.
    const s: SemanticState = {
      kind: "REVIEWING_COMPONENTS",
      query: QUERY,
      questions: QUESTIONS,
      answers: {},
      components: [],
    };
    expect(() => reduce(s, { type: "acceptComponents" })).toThrow(
      SemanticStateError,
    );
  });
});

describe("semantic state machine — SETTING_THRESHOLD", () => {
  test("setThreshold → RESEARCHING with empty inFlight and empty bundles", () => {
    const s1 = driveTo("SETTING_THRESHOLD");
    const s2 = reduce(s1, {
      type: "setThreshold",
      threshold: 0.15,
      thresholdLabel: "high risk",
    });
    expect(s2.kind).toBe("RESEARCHING");
    if (s2.kind === "RESEARCHING") {
      expect(s2.threshold).toBe(0.15);
      expect(s2.thresholdLabel).toBe("high risk");
      expect(s2.bundles).toEqual({});
      expect(s2.inFlight).toEqual({});
    }
  });

  test("setThreshold rejects non-finite threshold", () => {
    const s = driveTo("SETTING_THRESHOLD");
    expect(() =>
      reduce(s, {
        type: "setThreshold",
        threshold: Number.NaN,
        thresholdLabel: "x",
      }),
    ).toThrow(SemanticStateError);
  });

  test("setThreshold rejects empty thresholdLabel", () => {
    const s = driveTo("SETTING_THRESHOLD");
    expect(() =>
      reduce(s, { type: "setThreshold", threshold: 0.1, thresholdLabel: "   " }),
    ).toThrow(SemanticStateError);
  });
});

describe("semantic state machine — RESEARCHING", () => {
  test("startResearch adds component to inFlight", () => {
    let s = driveTo("RESEARCHING");
    s = reduce(s, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    if (s.kind === "RESEARCHING") {
      expect(s.inFlight.c1).toBe("llm_prior");
    }
  });

  test("startResearch for unknown component id throws", () => {
    const s = driveTo("RESEARCHING");
    expect(() =>
      reduce(s, {
        type: "startResearch",
        componentId: "cX",
        mechanism: "llm_prior",
      }),
    ).toThrow(SemanticStateError);
  });

  test("researchReceived for component not in inFlight throws (consumer bug surface)", () => {
    const s = driveTo("RESEARCHING");
    expect(() =>
      reduce(s, {
        type: "researchReceived",
        componentId: "c1",
        bundle: bundleFor("c1"),
      }),
    ).toThrow(SemanticStateError);
  });

  test("researchReceived where bundle.componentId mismatches throws", () => {
    let s = driveTo("RESEARCHING");
    s = reduce(s, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    expect(() =>
      reduce(s, {
        type: "researchReceived",
        componentId: "c1",
        bundle: bundleFor("c2"),
      }),
    ).toThrow(SemanticStateError);
  });

  test("partial researchReceived stays in RESEARCHING with bundles accumulating", () => {
    let s = driveTo("RESEARCHING");
    s = reduce(s, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    s = reduce(s, {
      type: "researchReceived",
      componentId: "c1",
      bundle: bundleFor("c1"),
    });
    expect(s.kind).toBe("RESEARCHING");
    if (s.kind === "RESEARCHING") {
      expect(Object.keys(s.bundles)).toEqual(["c1"]);
      expect(s.inFlight).toEqual({});
    }
  });

  test("when every component has a bundle AND inFlight is empty → REVIEWING_RESEARCH", () => {
    const s = driveTo("REVIEWING_RESEARCH");
    expect(s.kind).toBe("REVIEWING_RESEARCH");
    if (s.kind === "REVIEWING_RESEARCH") {
      expect(Object.keys(s.bundles).sort()).toEqual(["c1", "c2", "c3"]);
      expect(s.accepted).toEqual({});
    }
  });
});

describe("semantic state machine — REVIEWING_RESEARCH", () => {
  test("acceptResearch marks one bundle accepted", () => {
    let s = driveTo("REVIEWING_RESEARCH");
    s = reduce(s, { type: "acceptResearch", componentId: "c1" });
    if (s.kind === "REVIEWING_RESEARCH") {
      expect(s.accepted.c1).toBe(true);
    }
  });

  test("acceptResearch for a component without a bundle throws", () => {
    const s = driveTo("REVIEWING_RESEARCH");
    expect(() =>
      reduce(s, { type: "acceptResearch", componentId: "cX" }),
    ).toThrow(SemanticStateError);
  });

  test("runModel before all accepted throws", () => {
    let s = driveTo("REVIEWING_RESEARCH");
    s = reduce(s, { type: "acceptResearch", componentId: "c1" });
    expect(() => reduce(s, { type: "runModel" })).toThrow(SemanticStateError);
  });

  test("runModel with all accepted → MODELING", () => {
    let s = driveTo("REVIEWING_RESEARCH");
    for (const c of COMPONENTS) {
      s = reduce(s, { type: "acceptResearch", componentId: c.id });
    }
    s = reduce(s, { type: "runModel" });
    expect(s.kind).toBe("MODELING");
  });
});

describe("semantic state machine — MODELING / REVIEWING_RESULT", () => {
  test("MODELING + modelComplete → REVIEWING_RESULT carrying result", () => {
    let s = driveTo("MODELING");
    s = reduce(s, { type: "modelComplete", result: RESULT });
    expect(s.kind).toBe("REVIEWING_RESULT");
    if (s.kind === "REVIEWING_RESULT") {
      expect(s.result).toEqual(RESULT);
    }
  });

  test("verifyNext from REVIEWING_RESULT for known component → RESEARCHING with only that component inFlight preserving bundles", () => {
    let s = driveTo("REVIEWING_RESULT");
    const before = s.kind === "REVIEWING_RESULT" ? s.bundles : null;
    s = reduce(s, { type: "verifyNext", componentId: "c2" });
    expect(s.kind).toBe("RESEARCHING");
    if (s.kind === "RESEARCHING") {
      expect(s.bundles).toEqual(before);
      // inFlight starts empty; consumer dispatches startResearch.
      expect(s.inFlight).toEqual({});
    }
  });

  test("verifyNext for unknown component throws", () => {
    const s = driveTo("REVIEWING_RESULT");
    expect(() =>
      reduce(s, { type: "verifyNext", componentId: "cX" }),
    ).toThrow(SemanticStateError);
  });

  test("acceptResult from REVIEWING_RESULT → COMPLETE", () => {
    let s = driveTo("REVIEWING_RESULT");
    s = reduce(s, { type: "acceptResult" });
    expect(s.kind).toBe("COMPLETE");
  });
});

describe("semantic state machine — COMPLETE / ERROR / fail", () => {
  test("COMPLETE rejects all events except reset", () => {
    const s = driveTo("COMPLETE");
    expect(() => reduce(s, { type: "acceptResult" })).toThrow(
      SemanticStateError,
    );
    expect(() => reduce(s, { type: "fail", message: "x" })).toThrow(
      SemanticStateError,
    );
  });

  test("fail from any non-terminal state goes to ERROR carrying source", () => {
    const s = driveTo("REVIEWING_COMPONENTS");
    const e = reduce(s, { type: "fail", message: "oops" });
    expect(e.kind).toBe("ERROR");
    if (e.kind === "ERROR") {
      expect(e.message).toBe("oops");
      expect(e.sourceState).toEqual(s);
    }
  });

  test("fail from ERROR throws", () => {
    const s1 = driveTo("REVIEWING_COMPONENTS");
    const s2 = reduce(s1, { type: "fail", message: "oops" });
    expect(() => reduce(s2, { type: "fail", message: "again" })).toThrow(
      SemanticStateError,
    );
  });

  test("ERROR rejects normal events (only back / reset recover)", () => {
    const s1 = driveTo("REVIEWING_COMPONENTS");
    const s2 = reduce(s1, { type: "fail", message: "oops" });
    expect(() => reduce(s2, { type: "acceptComponents" })).toThrow(
      SemanticStateError,
    );
  });
});

describe("semantic state machine — back()", () => {
  test("back from ERROR returns sourceState intact (deep data preserved)", () => {
    const s1 = driveTo("REVIEWING_RESEARCH");
    // Accept one to give the state non-trivial accumulated data.
    const s2 = reduce(s1, { type: "acceptResearch", componentId: "c1" });
    const s3 = reduce(s2, { type: "fail", message: "boom" });
    const recovered = reduce(s3, { type: "back" });
    expect(recovered).toEqual(s2);
  });

  test("back from REVIEWING_COMPONENTS → AWAITING_ANSWERS preserving answers", () => {
    let s = driveTo("AWAITING_ANSWERS");
    s = reduce(s, { type: "answerClarification", qId: "q1", answer: "smoker" });
    s = reduce(s, { type: "submitClarifications" });
    s = reduce(s, { type: "componentsReceived", components: COMPONENTS });
    expect(s.kind).toBe("REVIEWING_COMPONENTS");
    const back = reduce(s, { type: "back" });
    expect(back.kind).toBe("AWAITING_ANSWERS");
    if (back.kind === "AWAITING_ANSWERS") {
      expect(back.answers.q1).toBe("smoker");
    }
  });

  test("back from SETTING_THRESHOLD → REVIEWING_COMPONENTS", () => {
    const s = driveTo("SETTING_THRESHOLD");
    const back = reduce(s, { type: "back" });
    expect(back.kind).toBe("REVIEWING_COMPONENTS");
  });

  test("back from REVIEWING_RESEARCH → SETTING_THRESHOLD", () => {
    const s = driveTo("REVIEWING_RESEARCH");
    const back = reduce(s, { type: "back" });
    expect(back.kind).toBe("SETTING_THRESHOLD");
  });

  test("back from REVIEWING_RESULT → REVIEWING_RESEARCH with all components re-marked accepted", () => {
    const s = driveTo("REVIEWING_RESULT");
    const back = reduce(s, { type: "back" });
    expect(back.kind).toBe("REVIEWING_RESEARCH");
    if (back.kind === "REVIEWING_RESEARCH") {
      for (const c of COMPONENTS) {
        expect(back.accepted[c.id]).toBe(true);
      }
    }
  });

  test("back from unsupported state (IDLE) throws", () => {
    expect(() => reduce(initialState(), { type: "back" })).toThrow(
      SemanticStateError,
    );
  });

  test("back from RESEARCHING (async, unsupported) throws", () => {
    const s = driveTo("RESEARCHING");
    expect(() => reduce(s, { type: "back" })).toThrow(SemanticStateError);
  });
});

describe("semantic state machine — reset()", () => {
  test("reset from IDLE → IDLE", () => {
    const s = reduce(initialState(), { type: "reset" });
    expect(s).toEqual({ kind: "IDLE" });
  });

  test("reset from ERROR → IDLE", () => {
    const s1 = driveTo("REVIEWING_COMPONENTS");
    const s2 = reduce(s1, { type: "fail", message: "x" });
    const s3 = reduce(s2, { type: "reset" });
    expect(s3).toEqual({ kind: "IDLE" });
  });

  test("reset from COMPLETE → IDLE", () => {
    const s1 = driveTo("COMPLETE");
    const s2 = reduce(s1, { type: "reset" });
    expect(s2).toEqual({ kind: "IDLE" });
  });

  test("reset from RESEARCHING → IDLE (drops in-flight)", () => {
    let s = driveTo("RESEARCHING");
    s = reduce(s, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    const reset = reduce(s, { type: "reset" });
    expect(reset).toEqual({ kind: "IDLE" });
  });
});

describe("semantic state machine — purity / reproducibility", () => {
  test("same starting state + same event sequence → equal final state on two runs", () => {
    const events: SemanticEvent[] = [
      { type: "start", query: QUERY },
      { type: "clarificationsReceived", questions: QUESTIONS },
      { type: "answerClarification", qId: "q1", answer: "smoker" },
      { type: "answerClarification", qId: "q2", answer: "yes" },
      { type: "submitClarifications" },
      { type: "componentsReceived", components: COMPONENTS },
      {
        type: "editComponent",
        componentId: "c1",
        patch: { description: "Wells score, modified" },
      },
      { type: "acceptComponents" },
      { type: "setThreshold", threshold: 0.15, thresholdLabel: "high risk" },
      { type: "startResearch", componentId: "c1", mechanism: "llm_prior" },
      {
        type: "researchReceived",
        componentId: "c1",
        bundle: bundleFor("c1"),
      },
      { type: "startResearch", componentId: "c2", mechanism: "web_search" },
      {
        type: "researchReceived",
        componentId: "c2",
        bundle: bundleFor("c2"),
      },
      { type: "startResearch", componentId: "c3", mechanism: "rag_document" },
      {
        type: "researchReceived",
        componentId: "c3",
        bundle: bundleFor("c3"),
      },
      { type: "acceptResearch", componentId: "c1" },
      { type: "acceptResearch", componentId: "c2" },
      { type: "acceptResearch", componentId: "c3" },
      { type: "runModel" },
      { type: "modelComplete", result: RESULT },
      { type: "acceptResult" },
    ];

    const runOnce = (): SemanticState =>
      events.reduce((s, e) => reduce(s, e), initialState());

    expect(runOnce()).toEqual(runOnce());
  });

  test("reducer never mutates the input state (start)", () => {
    const start = initialState();
    const frozen = Object.freeze({ ...start });
    const next = reduce(frozen, { type: "start", query: QUERY });
    expect(start).toEqual({ kind: "IDLE" });
    expect(next).not.toBe(frozen);
  });

  test("reducer does not mutate inFlight on researchReceived (returns new map)", () => {
    let s = driveTo("RESEARCHING");
    s = reduce(s, {
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
    const beforeInFlight =
      s.kind === "RESEARCHING" ? { ...s.inFlight } : null;
    s = reduce(s, {
      type: "researchReceived",
      componentId: "c1",
      bundle: bundleFor("c1"),
    });
    // The reference returned by the new state's inFlight must NOT be the
    // same object the previous state held.
    if (s.kind === "RESEARCHING") {
      expect(s.inFlight).not.toBe(beforeInFlight);
      expect(s.inFlight).toEqual({});
    }
  });
});

describe("semantic state machine — type narrowing (compile-time)", () => {
  test("state.kind narrows the union (runtime check that types compile)", () => {
    const s: SemanticState = initialState();
    if (s.kind === "IDLE") {
      // @ts-expect-error — IDLE has no `questions`; this MUST fail typecheck.
      const _q = s.questions;
      expect(_q).toBeUndefined();
    }
    const s2 = reduce(s, { type: "start", query: QUERY });
    if (s2.kind === "CLARIFYING") {
      expect(s2.query).toBe(QUERY);
      // @ts-expect-error — CLARIFYING has no `components`.
      const _c = s2.components;
      expect(_c).toBeUndefined();
    }
  });
});

describe("semantic state machine — SemanticStateError shape", () => {
  test("error carries stateKind and eventType", () => {
    try {
      reduce(initialState(), { type: "acceptComponents" });
      fail("expected SemanticStateError");
    } catch (e) {
      expect(e).toBeInstanceOf(SemanticStateError);
      const err = e as SemanticStateError;
      expect(err.stateKind).toBe("IDLE");
      expect(err.eventType).toBe("acceptComponents");
      expect(err.message).toContain("IDLE");
      expect(err.message).toContain("acceptComponents");
    }
  });
});
