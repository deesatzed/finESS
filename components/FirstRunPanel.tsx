"use client";

interface FirstRunPanelProps {
  onRunExample: () => void;
  onFocusInput: () => void;
}

export function FirstRunPanel({ onRunExample, onFocusInput }: FirstRunPanelProps) {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="max-w-xl text-center space-y-5">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.18em] text-[#64748b]">
            Start here
          </p>
          <h2 className="text-2xl font-semibold text-white">
            Run an uncertainty model in one click
          </h2>
          <p className="text-sm leading-6 text-[#94a3b8]">
            Use the built-in pulmonary embolism example to see the full graph,
            Monte Carlo simulation, sensitivity analysis, and narration without
            an API key.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRunExample}
            className="w-full sm:w-auto px-5 py-3 rounded bg-[#3b82f6] text-sm font-medium text-white hover:bg-[#2563eb] active:bg-[#1d4ed8] transition-colors"
          >
            Try instant PE demo
          </button>
          <button
            type="button"
            onClick={onFocusInput}
            className="w-full sm:w-auto px-5 py-3 rounded border border-[#334155] bg-[#1e293b] text-sm font-medium text-[#cbd5e1] hover:text-white hover:bg-[#2d3a50] transition-colors"
          >
            Type a custom question
          </button>
        </div>

        <p className="text-xs text-[#64748b]">
          Custom AI-generated graphs require a selected model and configured
          OpenRouter key. The instant demo runs locally.
        </p>
      </div>
    </div>
  );
}
