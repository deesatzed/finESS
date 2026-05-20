/**
 * A5 follow-up: server-side auto-advance for the semantic conversation.
 *
 * After the user's typed event lands in a state that REQUIRES an LLM call
 * (e.g. CLARIFYING needs the A3 adapter to populate questions;
 * PROPOSING_COMPONENTS needs the A4 adapter to populate the component
 * list), the server fires the adapter and applies the resulting event
 * before responding. That way one client PATCH produces a fully-advanced
 * state — the client never has to know the LLM exists.
 *
 * Design choices:
 *
 *  - Auto-advance is opt-in PER STATE. Today we auto-advance from
 *    CLARIFYING (calls A3) and from PROPOSING_COMPONENTS (calls A4).
 *    Anything else is returned to the client unchanged.
 *
 *  - On adapter failure we dispatch the `fail` event so the state machine
 *    moves to ERROR with the source state preserved (so `back()` recovers).
 *    We do NOT throw — the conversation must remain navigable.
 *
 *  - The adapters themselves go through lib/ai/openrouter-client.ts which
 *    already enforces timeout, single retry, and per-call cost ceiling.
 *
 *  - Audit events for the auto-advance side-effects are emitted by the
 *    caller (the API route), not here. This module is pure-ish — it
 *    returns the new state + a description of what it did; the route
 *    decides how to log it.
 */

import {
  reduce,
  SemanticStateError,
  type SemanticState,
} from "@/lib/semantic/state-machine";
import { requestClarifications, ClarifyError } from "@/lib/semantic/clarify";
import {
  proposeComponents,
  ProposeComponentsError,
} from "@/lib/semantic/propose-components";

export interface AutoAdvanceOptions {
  /** OpenRouter model id (caller-supplied; do NOT hardcode). */
  model: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Optional timeout override forwarded to callChat. */
  timeoutMs?: number;
  /** Optional cost-ceiling override forwarded to callChat. */
  costBudgetUsd?: number;
}

export interface AutoAdvanceStep {
  /** The event that was applied (LLM-derived or the synthetic fail). */
  eventType: string;
  /** State kind before this step. */
  fromState: SemanticState["kind"];
  /** State kind after this step. */
  toState: SemanticState["kind"];
  /** Wall-clock latency of the underlying LLM call, when present. */
  latencyMs?: number;
  /** USD cost of the LLM call, when present. */
  costUsd?: number;
  /** True if this step terminated in ERROR via the fail event. */
  failed: boolean;
}

export interface AutoAdvanceResult {
  /** Final state after zero or more auto-advance steps. */
  state: SemanticState;
  /** One entry per auto-advance step actually executed (may be empty). */
  steps: AutoAdvanceStep[];
}

/**
 * Apply zero or more auto-advance steps to `state` until the state is
 * one that requires user input. Bounded by `maxSteps` (default 4) so a
 * misbehaving adapter sequence can't loop forever.
 */
export async function autoAdvance(
  initial: SemanticState,
  opts: AutoAdvanceOptions,
  maxSteps = 4,
): Promise<AutoAdvanceResult> {
  let state = initial;
  const steps: AutoAdvanceStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const next = await advanceOnce(state, opts);
    if (next === null) break;
    steps.push(next.step);
    state = next.state;
    if (next.step.failed) break;
  }

  return { state, steps };
}

/**
 * Take one auto-advance step from `state`. Returns null when no further
 * auto-advance is appropriate (state requires user input or is terminal).
 */
async function advanceOnce(
  state: SemanticState,
  opts: AutoAdvanceOptions,
): Promise<{ state: SemanticState; step: AutoAdvanceStep } | null> {
  switch (state.kind) {
    case "CLARIFYING":
      return runClarifying(state, opts);
    case "PROPOSING_COMPONENTS":
      return runProposing(state, opts);
    default:
      return null;
  }
}

async function runClarifying(
  state: Extract<SemanticState, { kind: "CLARIFYING" }>,
  opts: AutoAdvanceOptions,
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  try {
    const result = await requestClarifications({
      query: state.query,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
    });
    const next = reduce(state, {
      type: "clarificationsReceived",
      questions: result.questions,
    });
    return {
      state: next,
      step: {
        eventType: "clarificationsReceived",
        fromState: "CLARIFYING",
        toState: next.kind,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        failed: false,
      },
    };
  } catch (err) {
    return applyFail(state, "CLARIFYING", err);
  }
}

async function runProposing(
  state: Extract<SemanticState, { kind: "PROPOSING_COMPONENTS" }>,
  opts: AutoAdvanceOptions,
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  try {
    const clarifications = state.questions.map((question) => ({
      question,
      answer: state.answers[question.id] ?? "",
    }));
    const result = await proposeComponents({
      query: state.query,
      clarifications,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
    });
    const next = reduce(state, {
      type: "componentsReceived",
      components: result.components,
    });
    return {
      state: next,
      step: {
        eventType: "componentsReceived",
        fromState: "PROPOSING_COMPONENTS",
        toState: next.kind,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        failed: false,
      },
    };
  } catch (err) {
    return applyFail(state, "PROPOSING_COMPONENTS", err);
  }
}

function applyFail(
  state: SemanticState,
  fromKind: SemanticState["kind"],
  err: unknown,
): { state: SemanticState; step: AutoAdvanceStep } {
  const message = describeError(err);
  // The reducer's `fail` is a universal transition from any non-terminal
  // state, so this is always safe.
  const next = reduce(state, { type: "fail", message });
  return {
    state: next,
    step: {
      eventType: "fail",
      fromState: fromKind,
      toState: next.kind,
      failed: true,
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof ClarifyError) {
    return `Clarifying step failed (${err.code}): ${err.message}`;
  }
  if (err instanceof ProposeComponentsError) {
    return `Component proposal failed (${err.code}): ${err.message}`;
  }
  if (err instanceof SemanticStateError) {
    return `State machine refused the LLM result: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
