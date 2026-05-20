"use client";

/**
 * SemanticHistory — chat-style scrolling history of every narration
 * line emitted during a semantic conversation. After REVIEWING_RESULT
 * the parent panel renders this in a collapsed left rail next to the
 * cockpit Dashboard.
 *
 * Pure presentational component: takes the narration entries and the
 * current state kind, renders the timeline. Recent entries are pinned
 * to the bottom (chat convention).
 */
import type { NarrationEntry } from "@/lib/semantic/narration";
import type { SemanticState } from "@/lib/semantic/state-machine";

interface SemanticHistoryProps {
  entries: NarrationEntry[];
  currentStateKind: SemanticState["kind"];
  /** When true, render compact rail view (used after REVIEWING_RESULT). */
  compact?: boolean;
}

export function SemanticHistory({
  entries,
  currentStateKind,
  compact = false,
}: SemanticHistoryProps) {
  const containerClass = compact
    ? "h-full overflow-y-auto p-2 space-y-1 text-[11px]"
    : "max-h-[260px] overflow-y-auto p-3 space-y-2 text-xs";

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Semantic conversation history"
      className={`rounded-md border border-[#1e293b] bg-[#0f1629] text-[#cbd5e1] ${containerClass}`}
    >
      {entries.length === 0 ? (
        <p className="italic text-[#475569]">
          Nothing yet. Start a conversation to see the step-by-step trail.
        </p>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.index}
            className="flex gap-2 leading-5"
            data-state-kind={entry.toStateKind}
          >
            <span className="shrink-0 text-[#475569]">
              {String(entry.index + 1).padStart(2, "0")}
            </span>
            <p>{entry.text}</p>
          </div>
        ))
      )}
      <p className="pt-2 text-[10px] uppercase tracking-wider text-[#475569]">
        current step: {currentStateKind}
      </p>
    </div>
  );
}

export default SemanticHistory;
