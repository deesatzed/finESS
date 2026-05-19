/**
 * Semantic Mode conversation state machine (Phase A1).
 *
 * Pure reducer — no I/O, no React, no Prisma, no LLM calls. The single
 * source of truth for what the Semantic Mode conversation surface can do.
 *
 * Persistence (A2), clarifying-call adapter (A3), component-proposal
 * adapter (A4), and the chat-style review UI (A5) all consume the
 * events and states defined here.
 *
 * Invalid event + state combinations throw `SemanticStateError`. The
 * reducer never silently no-ops; if a downstream consumer dispatches
 * something the conversation does not support, that is a consumer bug.
 *
 * Decisions encoded in this file (see plan A1 spec for context):
 *  1. `submitClarifications` is an explicit event. AWAITING_ANSWERS does
 *     not auto-advance once every question has an answer — the user can
 *     revise freely until they explicitly submit. This matches Principle
 *     6 ("a wide interval is useful honesty") and the design doc's
 *     emphasis on user control at every gate.
 *  2. `setThreshold` transitions SETTING_THRESHOLD → RESEARCHING with an
 *     EMPTY `inFlight` set. The user dispatches `startResearch` per
 *     component thereafter. Auto-kicking research for every component
 *     would prevent the user from picking a mechanism per component
 *     (Phase B6's research-mechanism picker).
 *  3. `researchReceived` for a component NOT in `inFlight` THROWS rather
 *     than no-ops. An out-of-band research response indicates a consumer
 *     bug (race condition, duplicated handler, stale promise resolving
 *     after `back`). Surfacing it loudly is safer than silently dropping.
 */

import type {
  ClarifyingQuestion,
  ComponentPatch,
  ModelRunResult,
  ProposedComponent,
  ResearchBundle,
  ResearchMechanism,
} from "./types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/**
 * Discriminated union over every legal Semantic Mode state.
 *
 * Each state's payload carries forward only the data that downstream
 * states need. The type system prevents accessing (for example)
 * `state.questions` when `state.kind === "IDLE"`.
 */
export type SemanticState =
  | { kind: "IDLE" }
  | { kind: "CLARIFYING"; query: string }
  | {
      kind: "AWAITING_ANSWERS";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
    }
  | {
      kind: "PROPOSING_COMPONENTS";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
    }
  | {
      kind: "REVIEWING_COMPONENTS";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
    }
  | {
      kind: "SETTING_THRESHOLD";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
    }
  | {
      kind: "RESEARCHING";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
      threshold: number;
      thresholdLabel: string;
      bundles: Record<string, ResearchBundle>;
      inFlight: Record<string, ResearchMechanism>;
    }
  | {
      kind: "REVIEWING_RESEARCH";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
      threshold: number;
      thresholdLabel: string;
      bundles: Record<string, ResearchBundle>;
      accepted: Record<string, true>;
    }
  | {
      kind: "MODELING";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
      threshold: number;
      thresholdLabel: string;
      bundles: Record<string, ResearchBundle>;
    }
  | {
      kind: "REVIEWING_RESULT";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
      threshold: number;
      thresholdLabel: string;
      bundles: Record<string, ResearchBundle>;
      result: ModelRunResult;
    }
  | {
      kind: "COMPLETE";
      query: string;
      questions: ClarifyingQuestion[];
      answers: Record<string, string>;
      components: ProposedComponent[];
      threshold: number;
      thresholdLabel: string;
      bundles: Record<string, ResearchBundle>;
      result: ModelRunResult;
    }
  | { kind: "ERROR"; message: string; sourceState: SemanticState };

export type SemanticStateKind = SemanticState["kind"];

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export type SemanticEvent =
  | { type: "start"; query: string }
  | { type: "clarificationsReceived"; questions: ClarifyingQuestion[] }
  | { type: "answerClarification"; qId: string; answer: string }
  | { type: "submitClarifications" }
  | { type: "componentsReceived"; components: ProposedComponent[] }
  | { type: "editComponent"; componentId: string; patch: ComponentPatch }
  | { type: "acceptComponents" }
  | { type: "setThreshold"; threshold: number; thresholdLabel: string }
  | { type: "startResearch"; componentId: string; mechanism: ResearchMechanism }
  | {
      type: "researchReceived";
      componentId: string;
      bundle: ResearchBundle;
    }
  | { type: "acceptResearch"; componentId: string }
  | { type: "runModel" }
  | { type: "modelComplete"; result: ModelRunResult }
  | { type: "verifyNext"; componentId: string }
  | { type: "acceptResult" }
  | { type: "fail"; message: string }
  | { type: "back" }
  | { type: "reset" };

export type SemanticEventType = SemanticEvent["type"];

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown whenever an event is dispatched that the current state does
 * not support, or whenever a precondition on a transition is violated
 * (e.g. running the model with un-accepted research bundles).
 */
export class SemanticStateError extends Error {
  readonly stateKind: SemanticStateKind;
  readonly eventType: SemanticEventType;

  constructor(
    stateKind: SemanticStateKind,
    eventType: SemanticEventType,
    detail: string,
  ) {
    super(
      `SemanticStateError: cannot apply event "${eventType}" in state "${stateKind}": ${detail}`,
    );
    this.name = "SemanticStateError";
    this.stateKind = stateKind;
    this.eventType = eventType;
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function initialState(): SemanticState {
  return { kind: "IDLE" };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply an event to a state and return the next state.
 *
 * Pure function: never mutates `state`. Always returns a freshly
 * constructed object. Throws `SemanticStateError` for any invalid
 * event/state combination or precondition violation.
 */
export function reduce(
  state: SemanticState,
  event: SemanticEvent,
): SemanticState {
  // `reset` is universally allowed.
  if (event.type === "reset") {
    return initialState();
  }

  // `fail` is allowed from every non-terminal state. ERROR + COMPLETE
  // are terminal-ish; failing from ERROR would lose source-state info,
  // and failing from COMPLETE is a consumer bug.
  if (event.type === "fail") {
    if (state.kind === "ERROR") {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "cannot fail from ERROR; use back() to recover then fail again",
      );
    }
    if (state.kind === "COMPLETE") {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "cannot fail from COMPLETE; the conversation is finished",
      );
    }
    return { kind: "ERROR", message: event.message, sourceState: state };
  }

  // `back` is only legal from specific states. See JSDoc on `backFrom`.
  if (event.type === "back") {
    return backFrom(state);
  }

  switch (state.kind) {
    case "IDLE":
      return reduceIdle(state, event);
    case "CLARIFYING":
      return reduceClarifying(state, event);
    case "AWAITING_ANSWERS":
      return reduceAwaitingAnswers(state, event);
    case "PROPOSING_COMPONENTS":
      return reduceProposingComponents(state, event);
    case "REVIEWING_COMPONENTS":
      return reduceReviewingComponents(state, event);
    case "SETTING_THRESHOLD":
      return reduceSettingThreshold(state, event);
    case "RESEARCHING":
      return reduceResearching(state, event);
    case "REVIEWING_RESEARCH":
      return reduceReviewingResearch(state, event);
    case "MODELING":
      return reduceModeling(state, event);
    case "REVIEWING_RESULT":
      return reduceReviewingResult(state, event);
    case "COMPLETE":
      return reduceComplete(state, event);
    case "ERROR":
      return reduceError(state, event);
  }
}

// ---------------------------------------------------------------------------
// Per-state reducers
// ---------------------------------------------------------------------------

/**
 * IDLE + start(query) → CLARIFYING. Nothing else is legal.
 */
function reduceIdle(
  state: SemanticState & { kind: "IDLE" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "start") {
    if (event.query.trim().length === 0) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "query must be non-empty",
      );
    }
    return { kind: "CLARIFYING", query: event.query };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * CLARIFYING accepts the async response from the clarifying LLM call
 * (`clarificationsReceived`). `fail` is handled at the top level.
 */
function reduceClarifying(
  state: SemanticState & { kind: "CLARIFYING" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "clarificationsReceived") {
    return {
      kind: "AWAITING_ANSWERS",
      query: state.query,
      questions: event.questions,
      answers: {},
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * AWAITING_ANSWERS accepts answers (in place — does NOT auto-advance)
 * and an explicit `submitClarifications` to move on. The user can
 * revise any answer until submit.
 */
function reduceAwaitingAnswers(
  state: SemanticState & { kind: "AWAITING_ANSWERS" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "answerClarification") {
    if (!state.questions.some((q) => q.id === event.qId)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `unknown question id "${event.qId}"`,
      );
    }
    return {
      ...state,
      answers: { ...state.answers, [event.qId]: event.answer },
    };
  }
  if (event.type === "submitClarifications") {
    return {
      kind: "PROPOSING_COMPONENTS",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * PROPOSING_COMPONENTS waits for the async LLM response.
 */
function reduceProposingComponents(
  state: SemanticState & { kind: "PROPOSING_COMPONENTS" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "componentsReceived") {
    return {
      kind: "REVIEWING_COMPONENTS",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: event.components,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * REVIEWING_COMPONENTS lets the user edit components in place
 * (`editComponent`) or accept the list (`acceptComponents`).
 * Acceptance requires at least one component.
 */
function reduceReviewingComponents(
  state: SemanticState & { kind: "REVIEWING_COMPONENTS" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "editComponent") {
    const idx = state.components.findIndex(
      (c) => c.id === event.componentId,
    );
    if (idx === -1) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `unknown component id "${event.componentId}"`,
      );
    }
    const nextComponents = state.components.slice();
    nextComponents[idx] = { ...nextComponents[idx], ...event.patch };
    return { ...state, components: nextComponents };
  }
  if (event.type === "acceptComponents") {
    if (state.components.length === 0) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "cannot accept an empty component list",
      );
    }
    return {
      kind: "SETTING_THRESHOLD",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * SETTING_THRESHOLD + setThreshold(t, label) → RESEARCHING with an
 * EMPTY in-flight set and no bundles. Consumers dispatch
 * `startResearch` per component thereafter (decision #2 in file
 * header).
 */
function reduceSettingThreshold(
  state: SemanticState & { kind: "SETTING_THRESHOLD" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "setThreshold") {
    if (!Number.isFinite(event.threshold)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "threshold must be a finite number",
      );
    }
    if (event.thresholdLabel.trim().length === 0) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        "thresholdLabel must be non-empty",
      );
    }
    return {
      kind: "RESEARCHING",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
      threshold: event.threshold,
      thresholdLabel: event.thresholdLabel,
      bundles: {},
      inFlight: {},
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * RESEARCHING accepts:
 *  - startResearch: adds a component to in-flight (mechanism recorded
 *    for audit / UI badge purposes).
 *  - researchReceived: removes from in-flight, stores bundle. If every
 *    component now has a bundle AND in-flight is empty, transitions to
 *    REVIEWING_RESEARCH.
 *
 * `researchReceived` for a component not currently in-flight throws
 * (decision #3 in file header).
 */
function reduceResearching(
  state: SemanticState & { kind: "RESEARCHING" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "startResearch") {
    if (!state.components.some((c) => c.id === event.componentId)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `unknown component id "${event.componentId}"`,
      );
    }
    return {
      ...state,
      inFlight: { ...state.inFlight, [event.componentId]: event.mechanism },
    };
  }
  if (event.type === "researchReceived") {
    if (!(event.componentId in state.inFlight)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `componentId "${event.componentId}" is not in-flight; consumer bug`,
      );
    }
    if (event.bundle.componentId !== event.componentId) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `bundle.componentId "${event.bundle.componentId}" does not match event.componentId "${event.componentId}"`,
      );
    }
    const remainingInFlight = removeKey(state.inFlight, event.componentId);
    const nextBundles = { ...state.bundles, [event.componentId]: event.bundle };
    const allComponentsCovered = state.components.every(
      (c) => c.id in nextBundles,
    );
    const noneInFlight = Object.keys(remainingInFlight).length === 0;
    if (allComponentsCovered && noneInFlight) {
      return {
        kind: "REVIEWING_RESEARCH",
        query: state.query,
        questions: state.questions,
        answers: state.answers,
        components: state.components,
        threshold: state.threshold,
        thresholdLabel: state.thresholdLabel,
        bundles: nextBundles,
        accepted: {},
      };
    }
    return { ...state, bundles: nextBundles, inFlight: remainingInFlight };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * REVIEWING_RESEARCH accepts:
 *  - acceptResearch(componentId): mark a bundle accepted.
 *  - runModel(): only legal once EVERY component is accepted.
 */
function reduceReviewingResearch(
  state: SemanticState & { kind: "REVIEWING_RESEARCH" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "acceptResearch") {
    if (!(event.componentId in state.bundles)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `no bundle present for component "${event.componentId}"`,
      );
    }
    return {
      ...state,
      accepted: { ...state.accepted, [event.componentId]: true },
    };
  }
  if (event.type === "runModel") {
    const missing = state.components.filter(
      (c) => state.accepted[c.id] !== true,
    );
    if (missing.length > 0) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `cannot runModel: ${missing.length} component(s) have un-accepted research (${missing
          .map((c) => c.id)
          .join(", ")})`,
      );
    }
    return {
      kind: "MODELING",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
      threshold: state.threshold,
      thresholdLabel: state.thresholdLabel,
      bundles: state.bundles,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * MODELING + modelComplete(result) → REVIEWING_RESULT.
 */
function reduceModeling(
  state: SemanticState & { kind: "MODELING" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "modelComplete") {
    return {
      kind: "REVIEWING_RESULT",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
      threshold: state.threshold,
      thresholdLabel: state.thresholdLabel,
      bundles: state.bundles,
      result: event.result,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * REVIEWING_RESULT accepts:
 *  - verifyNext(componentId): re-enter RESEARCHING with ONLY that
 *    component in-flight. Existing bundles are preserved.
 *  - acceptResult(): → COMPLETE.
 */
function reduceReviewingResult(
  state: SemanticState & { kind: "REVIEWING_RESULT" },
  event: SemanticEvent,
): SemanticState {
  if (event.type === "verifyNext") {
    if (!state.components.some((c) => c.id === event.componentId)) {
      throw new SemanticStateError(
        state.kind,
        event.type,
        `unknown component id "${event.componentId}"`,
      );
    }
    return {
      kind: "RESEARCHING",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
      threshold: state.threshold,
      thresholdLabel: state.thresholdLabel,
      bundles: state.bundles,
      // No default mechanism: the consumer dispatches startResearch
      // immediately after, picking the mechanism per UI.
      inFlight: {},
    };
  }
  if (event.type === "acceptResult") {
    return {
      kind: "COMPLETE",
      query: state.query,
      questions: state.questions,
      answers: state.answers,
      components: state.components,
      threshold: state.threshold,
      thresholdLabel: state.thresholdLabel,
      bundles: state.bundles,
      result: state.result,
    };
  }
  throw notApplicable(state.kind, event.type);
}

/**
 * COMPLETE is terminal. Only `reset` (handled at the top) leaves it.
 */
function reduceComplete(
  state: SemanticState & { kind: "COMPLETE" },
  event: SemanticEvent,
): SemanticState {
  throw notApplicable(state.kind, event.type);
}

/**
 * ERROR accepts no events directly — recovery is via `back` (to the
 * source state) or `reset` (to IDLE), both handled at the top level.
 */
function reduceError(
  state: SemanticState & { kind: "ERROR" },
  event: SemanticEvent,
): SemanticState {
  throw notApplicable(state.kind, event.type);
}

// ---------------------------------------------------------------------------
// back() handling
// ---------------------------------------------------------------------------

/**
 * `back` is intentionally restricted. The conversation does not support
 * arbitrary navigation because most transitions are either async
 * (CLARIFYING, PROPOSING_COMPONENTS, RESEARCHING, MODELING — in-flight
 * work would be orphaned) or terminal (COMPLETE). Only these are safe:
 *
 *  - ERROR              → state.sourceState (full data preserved)
 *  - REVIEWING_COMPONENTS → AWAITING_ANSWERS (preserves answers)
 *  - SETTING_THRESHOLD    → REVIEWING_COMPONENTS
 *  - REVIEWING_RESEARCH   → SETTING_THRESHOLD (lets user re-pick threshold;
 *                           bundles are discarded because the threshold
 *                           drives `verifyNext` semantics downstream)
 *  - REVIEWING_RESULT     → REVIEWING_RESEARCH (re-open per-component
 *                           review without losing accepted bundles)
 *
 * Anything else throws.
 */
function backFrom(state: SemanticState): SemanticState {
  switch (state.kind) {
    case "ERROR":
      return state.sourceState;
    case "REVIEWING_COMPONENTS":
      return {
        kind: "AWAITING_ANSWERS",
        query: state.query,
        questions: state.questions,
        answers: state.answers,
      };
    case "SETTING_THRESHOLD":
      return {
        kind: "REVIEWING_COMPONENTS",
        query: state.query,
        questions: state.questions,
        answers: state.answers,
        components: state.components,
      };
    case "REVIEWING_RESEARCH":
      return {
        kind: "SETTING_THRESHOLD",
        query: state.query,
        questions: state.questions,
        answers: state.answers,
        components: state.components,
      };
    case "REVIEWING_RESULT": {
      // Re-derive `accepted` as "all bundles accepted" since the user
      // had already accepted everything to reach REVIEWING_RESULT.
      const accepted: Record<string, true> = {};
      for (const c of state.components) {
        accepted[c.id] = true;
      }
      return {
        kind: "REVIEWING_RESEARCH",
        query: state.query,
        questions: state.questions,
        answers: state.answers,
        components: state.components,
        threshold: state.threshold,
        thresholdLabel: state.thresholdLabel,
        bundles: state.bundles,
        accepted,
      };
    }
    default:
      throw new SemanticStateError(
        state.kind,
        "back",
        "the conversation does not support arbitrary navigation; only specific back-transitions are safe",
      );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notApplicable(
  stateKind: SemanticStateKind,
  eventType: SemanticEventType,
): SemanticStateError {
  return new SemanticStateError(
    stateKind,
    eventType,
    "no transition defined for this event in this state",
  );
}

/**
 * Return a shallow copy of `obj` with `key` removed. Pure; never
 * mutates the input. Used in `reduceResearching` to drop a component
 * from `inFlight` once its bundle arrives.
 */
function removeKey<T>(
  obj: Record<string, T>,
  key: string,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) {
      out[k] = obj[k];
    }
  }
  return out;
}
