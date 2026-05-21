"use client";

/**
 * ResultStep — REVIEWING_RESULT and COMPLETE states. Renders the
 * "verify next" loop CTA (v2 addendum) above the cockpit handoff
 * slot. The parent SemanticPanel passes in the actual cockpit
 * (Dashboard) as a child so this component stays presentational
 * &mdash; the cockpit handoff approach is "mount Dashboard as a
 * child of SemanticPanel" and ResultStep simply renders the slot.
 */
import { useState } from "react";
import type {
  ProposedComponent,
  ModelRunResult,
} from "@/lib/semantic/types";
import type { ReactNode } from "react";

interface ResultStepProps {
  components: ProposedComponent[];
  result: ModelRunResult;
  threshold: number;
  thresholdLabel: string;
  /** The conversation id — used to build the export download URL. */
  conversationId: string;
  /** True iff the conversation has reached COMPLETE (not just REVIEWING_RESULT). */
  isComplete: boolean;
  isBusy: boolean;
  /** Rendered slot for the cockpit (Dashboard) handoff. */
  cockpitSlot: ReactNode;
  onVerifyNext: (componentId: string) => void;
  onAccept: () => void;
  onBack?: () => void;
  onReset: () => void;
}

export function ResultStep({
  components,
  result,
  threshold,
  thresholdLabel,
  conversationId,
  isComplete,
  isBusy,
  cockpitSlot,
  onVerifyNext,
  onAccept,
  onBack,
  onReset,
}: ResultStepProps) {
  const [downloading, setDownloading] = useState<"json" | "md" | null>(null);

  async function handleDownload(format: "json" | "md") {
    if (downloading) return;
    setDownloading(format);
    try {
      const res = await fetch(
        `/api/semantic/${conversationId}/export?format=${format}`,
      );
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `conversation-${conversationId.slice(0, 8)}.${format === "md" ? "md" : "json"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Silent failure — the UI remains functional; the console has the error.
    } finally {
      setDownloading(null);
    }
  }
  const topId = result.topSensitivityComponentId;
  const topComponent = topId
    ? components.find((c) => c.id === topId)
    : undefined;
  const pAbove = result.pAboveThreshold;

  return (
    <section
      aria-labelledby="result-heading"
      className="space-y-3"
    >
      <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4">
        <header className="flex items-center justify-between">
          <h2
            id="result-heading"
            className="text-sm font-semibold text-[#e2e8f0]"
          >
            {isComplete ? "Result accepted" : "Step 5 — Review the result"}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#64748b]">
              Threshold: {thresholdLabel} ({threshold})
            </span>
            <button
              type="button"
              onClick={() => handleDownload("json")}
              disabled={!!downloading}
              aria-label="Download analysis as JSON"
              className="rounded border border-[#1e293b] px-2 py-0.5 text-[10px] text-[#64748b] hover:border-[#3b82f6] hover:text-[#93c5fd] disabled:opacity-40"
            >
              {downloading === "json" ? "…" : "JSON"}
            </button>
            <button
              type="button"
              onClick={() => handleDownload("md")}
              disabled={!!downloading}
              aria-label="Download analysis as Markdown"
              className="rounded border border-[#1e293b] px-2 py-0.5 text-[10px] text-[#64748b] hover:border-[#3b82f6] hover:text-[#93c5fd] disabled:opacity-40"
            >
              {downloading === "md" ? "…" : "MD"}
            </button>
          </div>
        </header>
        {pAbove !== undefined && (
          <p className="mt-2 text-xs text-[#cbd5e1]">
            Probability of crossing the &quot;{thresholdLabel}&quot; line:{" "}
            <span className="font-semibold text-[#e2e8f0]">
              {(pAbove * 100).toFixed(1)}%
            </span>
            <span className="ml-2 text-[11px] text-[#94a3b8]">
              Read alongside the cockpit panels below for the full
              distribution &mdash; a point estimate alone hides the spread.
            </span>
          </p>
        )}
        {topComponent && !isComplete && (
          <div className="mt-3 rounded border border-amber-500 bg-amber-100/10 p-3">
            <p className="text-xs text-amber-200">
              <span className="font-semibold">Verify next:</span>{" "}
              &quot;{topComponent.name}&quot; is the biggest source of
              remaining uncertainty. Running another research pass on it
              would shrink the spread most.
            </p>
            <button
              type="button"
              onClick={() => onVerifyNext(topComponent.id)}
              disabled={isBusy}
              className="mt-2 rounded bg-amber-500 px-3 py-1 text-[11px] font-semibold text-amber-950 hover:bg-amber-400 disabled:opacity-50"
            >
              Re-research &quot;{topComponent.name}&quot;
            </button>
          </div>
        )}
      </div>

      <div aria-label="Cockpit handoff" className="min-h-[400px]">
        {cockpitSlot}
      </div>

      {!isComplete && (
        <footer className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                disabled={isBusy}
                className="rounded border border-[#1e293b] px-3 py-1.5 text-xs text-[#94a3b8] hover:text-white disabled:opacity-50"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onReset}
              disabled={isBusy}
              className="text-[11px] text-[#64748b] underline-offset-2 hover:text-[#94a3b8] hover:underline disabled:opacity-50"
            >
              Start over
            </button>
          </div>
          <button
            type="button"
            onClick={onAccept}
            disabled={isBusy}
            className="rounded bg-[#10b981] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#059669] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accept result
          </button>
        </footer>
      )}
    </section>
  );
}

export default ResultStep;
