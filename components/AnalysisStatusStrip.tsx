"use client";

import type { AnalysisStatus } from "@/lib/ui/analysis-status";

interface AnalysisStatusStripProps {
  status: AnalysisStatus;
  query: string | null;
  seed: number | null;
  onSaveLoad: () => void;
  onCalibration: () => void;
}

export function AnalysisStatusStrip({
  status,
  query,
  seed,
  onSaveLoad,
  onCalibration,
}: AnalysisStatusStripProps) {
  return (
    <section className="flex flex-col gap-2 border-b border-[#1e293b] bg-[#0f1629] px-4 py-2 text-xs text-[#94a3b8] md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-[#e2e8f0]">{status.label}</span>
          <span className="text-[#64748b]">{status.detail}</span>
          {seed !== null && (
            <span className="font-mono text-[#64748b]">seed {seed}</span>
          )}
        </div>
        <div className="mt-1 truncate text-[#64748b]">
          {query || "No query selected"} · Next: {status.nextAction}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSaveLoad}
          className="rounded border border-[#334155] bg-[#1e293b] px-3 py-1.5 font-medium text-[#cbd5e1] transition-colors hover:text-white"
        >
          Save / Load
        </button>
        <button
          type="button"
          onClick={onCalibration}
          disabled={!status.canCalibrate}
          title={
            status.canCalibrate
              ? "Record a real-world outcome"
              : "Save a completed analysis before recording outcomes"
          }
          className={`rounded border px-3 py-1.5 font-medium transition-colors ${
            status.canCalibrate
              ? "border-[#334155] bg-[#1e293b] text-[#cbd5e1] hover:text-white"
              : "cursor-not-allowed border-[#1e293b] bg-[#111827] text-[#64748b]"
          }`}
        >
          Calibration
        </button>
      </div>
    </section>
  );
}
