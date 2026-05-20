/**
 * Plain-language narration for Semantic Mode state transitions (Phase A5).
 *
 * Pure function — no I/O, no React. The SemanticPanel calls
 * `narrationFor(prevState, event, nextState)` after every successful
 * reducer dispatch and pushes the returned string into the narration
 * history that drives the cockpit's NarrationStream and the chat-style
 * SemanticHistory rail.
 *
 * The output strings must:
 *  - Stay in domain-neutral plain language (no statistical jargon).
 *  - Articulate disagreement and wide intervals as useful honesty when
 *    referencing them, never collapse a range to a point estimate.
 *  - Never echo the user's raw query text, clarifying answers, or
 *    component descriptions — the narration is a process breadcrumb,
 *    not a content summary.
 *
 * If a transition is not explicitly listed below, `narrationFor`
 * returns a neutral fallback that names only the from/to state kinds.
 * That covers paths added later (Phase B / Phase D) without forcing
 * this module to be updated in lockstep — but every meaningful
 * transition we ship today has a hand-crafted line.
 */
import type {
  SemanticEvent,
  SemanticState,
} from "./state-machine";

export interface NarrationEntry {
  /** Index of the transition in the history (0-based). */
  index: number;
  /** Plain-language sentence shown to the user. */
  text: string;
  /** The state kind we transitioned INTO. */
  toStateKind: SemanticState["kind"];
}

/**
 * Map a single (prevState, event, nextState) transition to one plain
 * language narration line. Pure: never mutates its arguments.
 */
export function narrationFor(
  prevState: SemanticState,
  event: SemanticEvent,
  nextState: SemanticState,
): string {
  // `reset` from anywhere collapses to a single line.
  if (event.type === "reset") {
    return "Starting over with a fresh conversation.";
  }

  // `fail` always lands us in ERROR with the message preserved.
  if (event.type === "fail") {
    const message =
      event.type === "fail" ? event.message.slice(0, 200) : "unknown";
    return `Something went wrong: ${message}. Click "back" to return to the previous step.`;
  }

  // `back` is intentionally informational — the user already knows
  // they pressed back; we just confirm the destination in plain words.
  if (event.type === "back") {
    return backwardNarration(nextState);
  }

  // Specific (from -> to) transitions, in the order they fire in a
  // typical conversation.
  const from = prevState.kind;
  const to = nextState.kind;

  if (from === "IDLE" && to === "CLARIFYING") {
    return "Thinking about what to ask first...";
  }

  if (from === "CLARIFYING" && to === "AWAITING_ANSWERS") {
    if (nextState.kind === "AWAITING_ANSWERS") {
      const n = nextState.questions.length;
      return `Asked ${n} clarifying question${n === 1 ? "" : "s"}. Take your time.`;
    }
    return "Clarifying questions ready.";
  }

  if (from === "AWAITING_ANSWERS" && to === "AWAITING_ANSWERS") {
    // answerClarification updates in place; narrate softly so the
    // user sees their typing is captured but doesn't get flooded.
    return "Answer captured. Edit any answer until you submit.";
  }

  if (from === "AWAITING_ANSWERS" && to === "PROPOSING_COMPONENTS") {
    return "Identifying the key uncertain factors...";
  }

  if (from === "PROPOSING_COMPONENTS" && to === "REVIEWING_COMPONENTS") {
    if (nextState.kind === "REVIEWING_COMPONENTS") {
      const n = nextState.components.length;
      return `Proposed ${n} component${n === 1 ? "" : "s"}. Edit any that need adjusting.`;
    }
    return "Components proposed. Review and edit.";
  }

  if (from === "REVIEWING_COMPONENTS" && to === "REVIEWING_COMPONENTS") {
    return "Component updated.";
  }

  if (from === "REVIEWING_COMPONENTS" && to === "SETTING_THRESHOLD") {
    return "Components accepted. What is the decision threshold?";
  }

  if (from === "SETTING_THRESHOLD" && to === "RESEARCHING") {
    return "Threshold set. Now researching each component's distribution.";
  }

  if (from === "RESEARCHING" && to === "RESEARCHING") {
    if (event.type === "startResearch") {
      return "Research started for one component.";
    }
    if (event.type === "researchReceived") {
      return "One component researched. Reviewing remaining components.";
    }
    return "Research in progress.";
  }

  if (from === "RESEARCHING" && to === "REVIEWING_RESEARCH") {
    return "All components researched. Review each before running the model.";
  }

  if (from === "REVIEWING_RESEARCH" && to === "REVIEWING_RESEARCH") {
    return "Research bundle accepted.";
  }

  if (from === "REVIEWING_RESEARCH" && to === "MODELING") {
    return "Running Monte Carlo over your full uncertainty model...";
  }

  if (from === "MODELING" && to === "REVIEWING_RESULT") {
    if (nextState.kind === "REVIEWING_RESULT") {
      const topId = nextState.result.topSensitivityComponentId;
      const topName = topId
        ? nextState.components.find((c) => c.id === topId)?.name ?? topId
        : null;
      if (topName) {
        return `Model complete. The biggest source of remaining uncertainty is "${topName}". Wide intervals here are useful honesty — they tell you where another research pass would shrink uncertainty most.`;
      }
      return "Model complete. Review the result; wide intervals are useful honesty.";
    }
    return "Model complete.";
  }

  if (from === "REVIEWING_RESULT" && to === "RESEARCHING") {
    return "Re-opening research on the highest-leverage component.";
  }

  if (from === "REVIEWING_RESULT" && to === "COMPLETE") {
    return "Result accepted. You can export the conversation as a defensibility document.";
  }

  if (to === "ERROR") {
    return "Something went wrong. Click \"back\" to return to the previous step.";
  }

  return `Moved from ${from} to ${to}.`;
}

/**
 * Build a single NarrationEntry by combining the next index, the
 * narration line, and the destination state kind. Callers use this
 * when appending to history; pure and trivially testable.
 */
export function buildNarrationEntry(
  index: number,
  prevState: SemanticState,
  event: SemanticEvent,
  nextState: SemanticState,
): NarrationEntry {
  return {
    index,
    text: narrationFor(prevState, event, nextState),
    toStateKind: nextState.kind,
  };
}

function backwardNarration(nextState: SemanticState): string {
  switch (nextState.kind) {
    case "AWAITING_ANSWERS":
      return "Back to the clarifying questions. Your answers are preserved.";
    case "REVIEWING_COMPONENTS":
      return "Back to the component list. Edits are preserved.";
    case "SETTING_THRESHOLD":
      return "Back to setting the decision threshold. Research bundles are kept for now but will be re-confirmed.";
    case "REVIEWING_RESEARCH":
      return "Back to the research review. Accepted bundles are preserved.";
    case "IDLE":
      return "Back to the start.";
    default:
      return `Back to ${nextState.kind}.`;
  }
}
