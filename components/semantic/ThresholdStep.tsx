"use client";

/**
 * ThresholdStep — SETTING_THRESHOLD step. The user picks the decision
 * threshold and a plain-language label for it. The final model run
 * will report `P(output > threshold)` so the threshold is the only
 * thing that turns a distribution into a decision.
 *
 * v2 addendum requirement: without this state, the conversation
 * produces a distribution but no decision-actionable answer.
 */
import { useState } from "react";

interface ThresholdStepProps {
  initialThreshold?: number;
  initialLabel?: string;
  isBusy: boolean;
  onSubmit: (threshold: number, thresholdLabel: string) => void;
  onBack?: () => void;
  onReset: () => void;
}

export function ThresholdStep({
  initialThreshold,
  initialLabel,
  isBusy,
  onSubmit,
  onBack,
  onReset,
}: ThresholdStepProps) {
  const [threshold, setThreshold] = useState<string>(
    initialThreshold !== undefined ? String(initialThreshold) : "",
  );
  const [label, setLabel] = useState<string>(initialLabel ?? "");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const parsed = Number(threshold);
    if (!Number.isFinite(parsed)) {
      setError("Threshold must be a number.");
      return;
    }
    if (label.trim().length === 0) {
      setError("Give the threshold a short plain-language label.");
      return;
    }
    setError(null);
    onSubmit(parsed, label.trim());
  };

  return (
    <section
      aria-labelledby="threshold-heading"
      className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 space-y-3"
    >
      <h2
        id="threshold-heading"
        className="text-sm font-semibold text-[#e2e8f0]"
      >
        Step 3 &mdash; Decision threshold
      </h2>
      <p className="text-xs text-[#94a3b8]">
        Pick the value at which the answer changes. The final result
        reports the probability of crossing this line &mdash; that turns
        a distribution into a decision.
      </p>
      <div className="space-y-2">
        <label className="block text-[11px] text-[#94a3b8]">
          Threshold value
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={isBusy}
            placeholder="e.g. 0.5 or 1500000"
            className="mt-1 w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1.5 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
          />
        </label>
        <label className="block text-[11px] text-[#94a3b8]">
          Plain-language label
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={isBusy}
            placeholder="e.g. high risk, go / no-go, on track"
            className="mt-1 w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1.5 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
          />
          <span className="mt-1 block text-[10px] italic text-[#64748b]">
            This is what the result panel will say (&quot;P(high risk) =
            18%&quot;).
          </span>
        </label>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-red-400">
          {error}
        </p>
      )}
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
          onClick={handleSubmit}
          disabled={isBusy}
          className="rounded bg-[#3b82f6] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue to research
        </button>
      </footer>
    </section>
  );
}

export default ThresholdStep;
