"use client";

/**
 * SemanticHonestyBanner — top-of-panel banner shown on every semantic
 * mode screen until the conversation reaches REVIEWING_RESULT, at
 * which point it collapses to a single line linking back to the
 * conversation history.
 *
 * The wording is load-bearing — it is the user's contract with the
 * tool. Do not soften "wide intervals are not failure — they are
 * useful honesty about what is and is not known": that line is the
 * core of Principle 6 and the design doc's non-statistical promise.
 *
 * No state, no dismiss control. The full banner has `role="region"`
 * with an aria-label so screen-reader users can skim past it.
 */
interface SemanticHonestyBannerProps {
  /** When true, render only the one-line collapsed summary. */
  collapsed?: boolean;
  /** Click handler for the collapsed-mode summary link. */
  onSummaryClick?: () => void;
  className?: string;
}

export function SemanticHonestyBanner({
  collapsed = false,
  onSummaryClick,
  className = "",
}: SemanticHonestyBannerProps) {
  if (collapsed) {
    return (
      <div
        role="region"
        aria-label="Semantic conversation summary"
        className={`rounded-md border-l-4 border-amber-500 bg-[#1e293b] px-3 py-2 text-xs text-amber-200 ${className}`}
      >
        <button
          type="button"
          onClick={onSummaryClick}
          className="font-medium underline-offset-2 hover:underline focus:underline focus:outline-none"
        >
          Conversation summary &rarr;
        </button>
        <span className="ml-3 text-amber-300/80">
          Wide intervals are useful honesty about what is and is not known.
        </span>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Semantic mode honesty banner"
      className={`rounded-md border-l-4 border-amber-500 bg-amber-100 px-4 py-3 text-xs text-amber-900 ${className}`}
    >
      <p className="font-semibold leading-5">
        This is the semantic conversation surface. We will:
      </p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 leading-5">
        <li>Ask clarifying questions to surface what your question implies.</li>
        <li>
          Identify key components &mdash; uncertain factors that shape the
          answer.
        </li>
        <li>Set the decision threshold for the result.</li>
        <li>
          Research each component&apos;s distribution (literature, web,
          multi-LLM, real data, or your expert estimates).
        </li>
        <li>Run the model with all uncertainty propagated.</li>
        <li>
          Show you which components drove the result and offer to research
          them more deeply.
        </li>
      </ol>
      <p className="mt-2 leading-5">
        <span className="font-semibold">
          Wide intervals are not failure &mdash; they are useful honesty about
          what is and is not known.
        </span>
      </p>
      <p className="mt-1 leading-5 text-amber-800">
        At any step you can go back, edit, or restart.
      </p>
    </div>
  );
}

export default SemanticHonestyBanner;
