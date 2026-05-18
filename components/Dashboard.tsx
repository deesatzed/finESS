"use client";

import type { ReactNode } from "react";
import { PathADraftBanner } from "@/components/PathADraftBanner";

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
}

function Panel({ title, children, className = "" }: PanelProps) {
  return (
    <div
      className={`bg-[#0f1629] rounded-lg border border-[#1e293b] overflow-hidden flex flex-col panel-hover ${className}`}
    >
      <div className="px-3 py-1.5 border-b border-[#1e293b] flex-shrink-0">
        <h3 className="text-xs font-medium text-[#64748b] uppercase tracking-wider">
          {title}
        </h3>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

interface DashboardProps {
  nodeNetwork: ReactNode;
  liveDistribution: ReactNode;
  sensitivityRadar: ReactNode;
  gaugePanel: ReactNode;
  spectrumBars: ReactNode;
  narrationStream: ReactNode;
  /**
   * Active analysis mode for the currently displayed result.
   * - "simulation": Path A (LLM-generated graph + Monte Carlo). Renders the
   *   PathADraftBanner so the user knows the numbers are a draft prior.
   * - "observed":  Path B (real CSV-derived empirical result). No banner.
   * - undefined:   No graph yet (initial / Real Data Mode entry view). No banner.
   */
  analysisMode?: "simulation" | "observed";
}

export function Dashboard({
  nodeNetwork,
  liveDistribution,
  sensitivityRadar,
  gaugePanel,
  spectrumBars,
  narrationStream,
  analysisMode,
}: DashboardProps) {
  const showPathADraftBanner = analysisMode === "simulation";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
      {showPathADraftBanner && <PathADraftBanner />}
      <div className="flex-1 min-h-0 grid grid-cols-1 auto-rows-[minmax(260px,auto)] gap-2 md:grid-cols-2 lg:grid-cols-12 lg:grid-rows-6 lg:auto-rows-auto">
        {/* Panel 1: Node Network — center, largest (cols 1-8, rows 1-4) */}
        <Panel title="Node Network" className="md:col-span-2 lg:col-span-8 lg:row-span-4 min-h-[360px] lg:min-h-0">
          {nodeNetwork}
        </Panel>

        {/* Panel 2: Live Distribution — top right (cols 9-12, rows 1-2) */}
        <Panel title="Live Distribution" className="lg:col-span-4 lg:row-span-2">
          {liveDistribution}
        </Panel>

        {/* Panel 3: Sensitivity Radar — mid right (cols 9-12, rows 3-4) */}
        <Panel title="Sensitivity Analysis" className="lg:col-span-4 lg:row-span-2">
          {sensitivityRadar}
        </Panel>

        {/* Panel 4: Uncertainty Gauges — bottom left (cols 1-4, rows 5-6) */}
        <Panel title="Uncertainty Gauges" className="lg:col-span-4 lg:row-span-2">
          {gaugePanel}
        </Panel>

        {/* Panel 5: Spectrum Bars — bottom center (cols 5-8, rows 5-6) */}
        <Panel title="Spectrum Bars" className="lg:col-span-4 lg:row-span-2">
          {spectrumBars}
        </Panel>

        {/* Panel 6: Narration Stream — bottom right (cols 9-12, rows 5-6) */}
        <Panel title="Narration" className="lg:col-span-4 lg:row-span-2">
          {narrationStream}
        </Panel>
      </div>
    </div>
  );
}
