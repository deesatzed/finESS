/**
 * P3a — runModeling() unit tests.
 *
 * Exercises the MODELING auto-advance path end-to-end without a live DB.
 * We call autoAdvance() directly with a synthetic MODELING state that has
 * real ResearchBundles — the function calls bundleToNode(), runSimulation(),
 * and computeSensitivity() which are pure / deterministic at fixed seeds.
 *
 * Tests:
 *  1. Single-component conversation advances to REVIEWING_RESULT.
 *  2. Multi-component conversation produces a REVIEWING_RESULT with a
 *     topSensitivityComponentId that belongs to one of the real components.
 *  3. Missing bundle for a component transitions to ERROR state.
 *  4. ModelRunResult.pAboveThreshold is in [0, 1].
 *  5. autoAdvance returns a step with eventType "modelComplete" and failed:false.
 *  6. Missing bundle step has eventType "fail" and failed:true.
 */

import type {
  SemanticState,
} from "@/lib/semantic/state-machine";
import type { ResearchBundle, ProposedComponent } from "@/lib/semantic/types";

// We test the exported advanceOnce helper indirectly through autoAdvance.
// autoAdvance is the safe wrapper that already calls advanceOnce for us.
// Both live in the same module.
import { autoAdvance } from "@/lib/semantic/auto-advance";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComponent(id: string, name: string): ProposedComponent {
  return {
    id,
    name,
    description: `Description of ${name}`,
    unit: "probability",
    rangeMin: 0,
    rangeMax: 1,
  };
}

function makeBundle(componentId: string): ResearchBundle {
  return {
    componentId,
    mechanism: "llm_prior",
    proposedDistribution: "normal",
    proposedParams: { mean: 0.35, sd: 0.1 },
    reasoning: "Test prior for automated modeling test",
    citations: [{ source: "Test citation 1" }, { source: "Test citation 2" }],
  };
}

const BASE_STATE_FIELDS = {
  query: "What is the probability the patient has PE?",
  questions: [],
  answers: {},
  threshold: 0.5,
  thresholdLabel: "Clinical threshold",
};

function makeSingleComponentModelingState(): SemanticState & { kind: "MODELING" } {
  const comp = makeComponent("c1", "Pre-test probability");
  return {
    kind: "MODELING",
    ...BASE_STATE_FIELDS,
    components: [comp],
    bundles: { c1: makeBundle("c1") },
  };
}

function makeMultiComponentModelingState(): SemanticState & { kind: "MODELING" } {
  const c1 = makeComponent("c1", "Pre-test probability");
  const c2 = makeComponent("c2", "D-dimer sensitivity");
  const c3 = makeComponent("c3", "CT-PA specificity");
  return {
    kind: "MODELING",
    ...BASE_STATE_FIELDS,
    components: [c1, c2, c3],
    bundles: {
      c1: makeBundle("c1"),
      c2: { ...makeBundle("c2"), proposedParams: { mean: 0.95, sd: 0.03 } },
      c3: { ...makeBundle("c3"), proposedParams: { mean: 0.83, sd: 0.05 } },
    },
  };
}

function makeMissingBundleModelingState(): SemanticState & { kind: "MODELING" } {
  const c1 = makeComponent("c1", "Pre-test probability");
  const c2 = makeComponent("c2", "Orphan component — no bundle");
  return {
    kind: "MODELING",
    ...BASE_STATE_FIELDS,
    components: [c1, c2],
    bundles: { c1: makeBundle("c1") },  // c2 bundle intentionally omitted
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runModeling via autoAdvance — single component", () => {
  it("advances to REVIEWING_RESULT", async () => {
    const state = makeSingleComponentModelingState();
    const result = await autoAdvance(state, {});
    expect(result.state.kind).toBe("REVIEWING_RESULT");
  });

  it("returns a step with eventType modelComplete and failed:false", async () => {
    const state = makeSingleComponentModelingState();
    const result = await autoAdvance(state, {});
    const step = result.steps[0];
    expect(step).toBeDefined();
    expect(step.eventType).toBe("modelComplete");
    expect(step.failed).toBe(false);
    expect(step.fromState).toBe("MODELING");
    expect(step.toState).toBe("REVIEWING_RESULT");
  });

  it("produces pAboveThreshold in [0, 1]", async () => {
    const state = makeSingleComponentModelingState();
    const result = await autoAdvance(state, {});
    const nextState = result.state as Extract<SemanticState, { kind: "REVIEWING_RESULT" }>;
    const p = nextState.result.pAboveThreshold;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("has a non-negative latencyMs", async () => {
    const state = makeSingleComponentModelingState();
    const result = await autoAdvance(state, {});
    const step = result.steps[0];
    expect(step).toBeDefined();
    expect(step.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runModeling via autoAdvance — multi-component", () => {
  it("advances to REVIEWING_RESULT", async () => {
    const state = makeMultiComponentModelingState();
    const result = await autoAdvance(state, {});
    expect(result.state.kind).toBe("REVIEWING_RESULT");
  });

  it("topSensitivityComponentId is one of the real component IDs", async () => {
    const state = makeMultiComponentModelingState();
    const result = await autoAdvance(state, {});
    const nextState = result.state as Extract<SemanticState, { kind: "REVIEWING_RESULT" }>;
    const topId = nextState.result.topSensitivityComponentId;
    expect(["c1", "c2", "c3"]).toContain(topId);
  });

  it("topSensitivityComponentId is not the synthetic _semantic_output node", async () => {
    const state = makeMultiComponentModelingState();
    const result = await autoAdvance(state, {});
    const nextState = result.state as Extract<SemanticState, { kind: "REVIEWING_RESULT" }>;
    expect(nextState.result.topSensitivityComponentId).not.toBe("_semantic_output");
  });

  it("pAboveThreshold is in [0, 1]", async () => {
    const state = makeMultiComponentModelingState();
    const result = await autoAdvance(state, {});
    const nextState = result.state as Extract<SemanticState, { kind: "REVIEWING_RESULT" }>;
    const p = nextState.result.pAboveThreshold;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("raw result carries mean, median, ciLow, ciHigh, seed", async () => {
    const state = makeMultiComponentModelingState();
    const result = await autoAdvance(state, {});
    const nextState = result.state as Extract<SemanticState, { kind: "REVIEWING_RESULT" }>;
    const raw = nextState.result.raw as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(typeof raw.mean).toBe("number");
    expect(typeof raw.median).toBe("number");
    expect(typeof raw.ciLow).toBe("number");
    expect(typeof raw.ciHigh).toBe("number");
    expect(typeof raw.seed).toBe("number");
  });
});

describe("runModeling via autoAdvance — missing bundle", () => {
  it("transitions to ERROR when a component has no bundle", async () => {
    const state = makeMissingBundleModelingState();
    const result = await autoAdvance(state, {});
    expect(result.state.kind).toBe("ERROR");
  });

  it("returns a step with eventType fail and failed:true", async () => {
    const state = makeMissingBundleModelingState();
    const result = await autoAdvance(state, {});
    const step = result.steps[0];
    expect(step).toBeDefined();
    expect(step.eventType).toBe("fail");
    expect(step.failed).toBe(true);
  });

  it("ERROR state message mentions the missing component", async () => {
    const state = makeMissingBundleModelingState();
    const result = await autoAdvance(state, {});
    const errState = result.state as Extract<SemanticState, { kind: "ERROR" }>;
    expect(errState.message).toMatch(/Orphan component/i);
  });
});
